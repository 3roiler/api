import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import AppError from './error.js';
import type {
  Comment,
  CommentWithAuthor,
  CommentMute,
  CommentTargetType
} from '../models/index.js';

/**
 * Generischer Kommentar-Service für polymorphe Targets (Clip, Blog-Post)
 * inkl. Threading, Soft-Delete + Moderator-Delete-mit-Grund.
 *
 * Designentscheidungen:
 *  - Eine `comment`-Tabelle für alle Targets — `target_type` + `target_id`
 *    sind die Polymorphie-Anker. Keine FK auf das Target, weil ein
 *    polymorphes FK eh nicht möglich ist; Konsistenz beim Insert prüfen
 *    wir hier.
 *  - Threading via `parent_comment_id` (self-ref). Frontend cappt die
 *    sichtbare Tiefe — Backend rendert nur „flach + 1 Eltern-Index" und
 *    überlässt das Bauen der Tree-Struktur dem Client.
 *  - Anti-Spam:
 *      · 30 s gleicher User auf gleichen Parent/Target,
 *      · plus globaler Mute via `comment_mute`.
 *  - Soft-Delete bleibt sichtbar als Platzhalter („Gelöschter Kommentar
 *    (Grund: X)"), nicht stillschweigend ausgeblendet. So sind Threads
 *    nachvollziehbar.
 */

const COMMENT_COLUMNS_PLAIN = `
  id,
  parent_comment_id AS "parentCommentId",
  target_type AS "targetType",
  target_id AS "targetId",
  user_id AS "userId",
  body,
  timestamp_seconds::float8 AS "timestampSeconds",
  deleted_at AS "deletedAt",
  deleted_by_user_id AS "deletedByUserId",
  deletion_reason AS "deletionReason",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const COMMENT_COLUMNS_ALIASED = `
  c.id,
  c.parent_comment_id AS "parentCommentId",
  c.target_type AS "targetType",
  c.target_id AS "targetId",
  c.user_id AS "userId",
  c.body,
  c.timestamp_seconds::float8 AS "timestampSeconds",
  c.deleted_at AS "deletedAt",
  c.deleted_by_user_id AS "deletedByUserId",
  c.deletion_reason AS "deletionReason",
  c.created_at AS "createdAt",
  c.updated_at AS "updatedAt"
`;

const COMMENT_WITH_AUTHOR_SELECT = `
  SELECT ${COMMENT_COLUMNS_ALIASED},
    u.name AS "authorName",
    u.display_name AS "authorDisplayName",
    u.avatar_url AS "authorAvatarUrl",
    u.deleted_at AS "authorDeletedAt"
  FROM public."comment" c
  JOIN public."user" u ON u.id = c.user_id
`;

export class CommentService {
  /** Alle Kommentare (inkl. soft-deleted) zu einem Target. Frontend
   *  baut den Tree und filtert ggf. self-deleted ohne Replies aus. */
  async listForTarget(targetType: CommentTargetType, targetId: string): Promise<CommentWithAuthor[]> {
    const result: QueryResult<CommentWithAuthor> = await persistence.database.query(
      `${COMMENT_WITH_AUTHOR_SELECT}
       WHERE c.target_type = $1 AND c.target_id = $2::uuid
       ORDER BY c.created_at ASC`,
      [targetType, targetId]
    );
    return result.rows;
  }

  /** Einzelner Kommentar mit Author — für Mod-Aktionen, die nur die ID kennen. */
  async getById(commentId: string): Promise<CommentWithAuthor | null> {
    const result: QueryResult<CommentWithAuthor> = await persistence.database.query(
      `${COMMENT_WITH_AUTHOR_SELECT}
       WHERE c.id = $1::uuid`,
      [commentId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Erstellt einen Kommentar. Validiert Body, Mute, Cooldown, und —
   * wenn `parentCommentId` gesetzt — dass der Parent existiert und
   * zum selben Target gehört. Sonst könnte ein böser Client ein Reply
   * an einen Kommentar auf einem anderen Clip hängen.
   */
  async create(input: {
    targetType: CommentTargetType;
    targetId: string;
    userId: string;
    body: string;
    timestampSeconds: number | null;
    parentCommentId: string | null;
    /** Wenn true, wird der 30-s-Cooldown übersprungen — gedacht für
     *  Moderatoren, die in einem Thread schnell hintereinander auf
     *  mehrere Posts reagieren müssen. Mute-Check und Body-Validation
     *  laufen trotzdem. */
    bypassCooldown?: boolean;
  }): Promise<Comment> {
    const trimmed = input.body.trim();
    if (trimmed.length === 0) {
      throw AppError.badRequest('Kommentar darf nicht leer sein.', 'EMPTY_COMMENT');
    }
    if (trimmed.length > 2000) {
      throw AppError.badRequest('Kommentar zu lang (max. 2000 Zeichen).', 'COMMENT_TOO_LONG');
    }
    if (
      input.timestampSeconds !== null &&
      (!Number.isFinite(input.timestampSeconds) || input.timestampSeconds < 0)
    ) {
      throw AppError.badRequest('timestampSeconds muss ≥ 0 sein.', 'BAD_TIMESTAMP');
    }
    if (input.targetType === 'blog_post' && input.timestampSeconds !== null) {
      throw AppError.badRequest('Blog-Kommentare haben keinen Clip-Timestamp.', 'TIMESTAMP_NOT_ALLOWED');
    }

    // Target-Existenz prüfen. Wir haben keine FK von comment.target_id
    // auf eine konkrete Tabelle (polymorph), also könnte ein Client
    // sonst Kommentare auf random UUIDs einfügen — Orphans, die in
    // keinem Render-Pfad auftauchen, aber Storage fressen und ein
    // einfacher Spam-Vektor wären. Blog-Targets werden bereits im
    // Controller via slug → post.id aufgelöst (impliziter Check);
    // Clip-Targets bekommen ihn hier.
    if (input.targetType === 'clip') {
      const clipExists = await persistence.database.query(
        `SELECT 1 FROM public."clip" WHERE id = $1::uuid`,
        [input.targetId]
      );
      if (clipExists.rowCount === 0) {
        throw AppError.notFound('Clip nicht gefunden.', 'CLIP_NOT_FOUND');
      }
    }

    // Mute-Check.
    const mute = await this.getMuteFor(input.userId);
    if (mute !== null) {
      const reason = mute.reason || 'Kommentieren gesperrt.';
      throw AppError.forbidden(reason, 'USER_MUTED');
    }

    // Parent-Validierung bei Reply. Echte Reddit-Style-Tiefe — wir
    // erzwingen nur, dass der Parent zum selben Target gehört
    // (kein Cross-Posting). Die visuelle Indentierung wird vom
    // Frontend bei einer gewissen Tiefe gecappt, damit lange
    // Diskussionen auf mobilen Viewports lesbar bleiben — logisch
    // bleibt der Baum aber komplett.
    if (input.parentCommentId !== null) {
      const parentRes = await persistence.database.query<{
        targetType: CommentTargetType;
        targetId: string;
      }>(
        `SELECT target_type AS "targetType",
                target_id AS "targetId"
         FROM public."comment"
         WHERE id = $1::uuid`,
        [input.parentCommentId]
      );
      const parent = parentRes.rows[0];
      if (!parent) {
        throw AppError.notFound('Eltern-Kommentar nicht gefunden.', 'PARENT_NOT_FOUND');
      }
      if (parent.targetType !== input.targetType || parent.targetId !== input.targetId) {
        throw AppError.badRequest('Eltern-Kommentar gehört zu einem anderen Beitrag.', 'PARENT_MISMATCH');
      }
    }

    // 30 s Cooldown — gleicher User auf gleichen Parent/Target. Mods
    // können das per `bypassCooldown` überspringen (für Mod-Antworten
    // in laufenden Threads). Wir bauen die Param-Liste passend zum
    // SQL: 3 Werte bei Top-Level Posts, 4 Werte bei Replies.
    if (input.bypassCooldown !== true) {
      const cooldownParams: unknown[] = [input.targetType, input.targetId, input.userId];
      let cooldownParentClause = 'parent_comment_id IS NULL';
      if (input.parentCommentId !== null) {
        cooldownParams.push(input.parentCommentId);
        cooldownParentClause = `parent_comment_id = $${cooldownParams.length}::uuid`;
      }
      const recentRes: QueryResult<{ count: string }> = await persistence.database.query(
        `SELECT COUNT(*)::text AS count FROM public."comment"
         WHERE target_type = $1
           AND target_id = $2::uuid
           AND user_id = $3::uuid
           AND ${cooldownParentClause}
           AND created_at >= NOW() - INTERVAL '30 seconds'
           AND deleted_at IS NULL`,
        cooldownParams
      );
      if (Number(recentRes.rows[0]?.count ?? 0) > 0) {
        throw AppError.tooManyRequests(
          'Bitte 30 Sekunden warten, bevor du erneut kommentierst.',
          'COMMENT_COOLDOWN'
        );
      }
    }

    const result: QueryResult<Comment> = await persistence.database.query(
      `INSERT INTO public."comment"
         (parent_comment_id, target_type, target_id, user_id, body, timestamp_seconds)
       VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6)
       RETURNING ${COMMENT_COLUMNS_PLAIN}`,
      [
        input.parentCommentId,
        input.targetType,
        input.targetId,
        input.userId,
        trimmed,
        input.timestampSeconds
      ]
    );
    return result.rows[0];
  }

  /**
   * Soft-Delete durch den Autor. Idempotent: zweites Aufrufen ist kein
   * Fehler, aber wir blocken den Aufruf wenn ein Moderator schon
   * gelöscht hat (Author kann den Mod-Grund nicht überschreiben).
   */
  async deleteOwn(commentId: string, userId: string): Promise<void> {
    const row = await this.getRawForDelete(commentId);
    if (!row) {
      throw AppError.notFound('Kommentar nicht gefunden.', 'COMMENT_NOT_FOUND');
    }
    if (row.userId !== userId) {
      throw AppError.forbidden('Du darfst diesen Kommentar nicht löschen.', 'COMMENT_FORBIDDEN');
    }
    if (row.deletedAt !== null && row.deletionReason !== null) {
      // Schon mod-gelöscht — nicht überschreiben.
      return;
    }
    await persistence.database.query(
      `UPDATE public."comment"
       SET deleted_at = COALESCE(deleted_at, NOW()),
           deleted_by_user_id = $2::uuid,
           deletion_reason = NULL,
           updated_at = NOW()
       WHERE id = $1::uuid`,
      [commentId, userId]
    );
  }

  /**
   * Soft-Delete durch einen Moderator mit Begründung. Der Grund wird
   * dem Reader transparent angezeigt („Gelöscht durch Moderator —
   * Grund: X").
   */
  async deleteAsModerator(commentId: string, moderatorId: string, reason: string): Promise<void> {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw AppError.badRequest('Begründung darf nicht leer sein.', 'EMPTY_REASON');
    }
    if (trimmed.length > 500) {
      throw AppError.badRequest('Begründung zu lang (max. 500 Zeichen).', 'REASON_TOO_LONG');
    }
    const exists = await persistence.database.query(
      `SELECT 1 FROM public."comment" WHERE id = $1::uuid`,
      [commentId]
    );
    if (exists.rowCount === 0) {
      throw AppError.notFound('Kommentar nicht gefunden.', 'COMMENT_NOT_FOUND');
    }
    await persistence.database.query(
      `UPDATE public."comment"
       SET deleted_at = NOW(),
           deleted_by_user_id = $2::uuid,
           deletion_reason = $3,
           updated_at = NOW()
       WHERE id = $1::uuid`,
      [commentId, moderatorId, trimmed]
    );
  }

  /**
   * Wiederherstellen — nur durch Mods. Archiviert den letzten
   * Lösch-Grund in `last_deletion_reason` und stempelt
   * `restored_at` + `restored_by_user_id`, damit die Mod-Aktion
   * nachvollziehbar bleibt (vorher ging der Audit komplett verloren).
   */
  async restore(commentId: string, moderatorId: string): Promise<void> {
    const exists = await persistence.database.query(
      `SELECT 1 FROM public."comment" WHERE id = $1::uuid`,
      [commentId]
    );
    if (exists.rowCount === 0) {
      throw AppError.notFound('Kommentar nicht gefunden.', 'COMMENT_NOT_FOUND');
    }
    await persistence.database.query(
      `UPDATE public."comment"
       SET deleted_at = NULL,
           deleted_by_user_id = NULL,
           last_deletion_reason = deletion_reason,
           deletion_reason = NULL,
           restored_at = NOW(),
           restored_by_user_id = $2::uuid,
           updated_at = NOW()
       WHERE id = $1::uuid`,
      [commentId, moderatorId]
    );
  }

  // ─── Mute-Verwaltung ───────────────────────────────────────────────

  async getMuteFor(userId: string): Promise<CommentMute | null> {
    const res = await persistence.database.query<CommentMute>(
      `SELECT user_id AS "userId",
              reason,
              muted_by_user_id AS "mutedByUserId",
              muted_until AS "mutedUntil",
              created_at AS "createdAt"
       FROM public."comment_mute"
       WHERE user_id = $1::uuid
         AND (muted_until IS NULL OR muted_until > NOW())`,
      [userId]
    );
    return res.rows[0] ?? null;
  }

  async mute(input: {
    userId: string;
    moderatorId: string;
    reason: string;
    mutedUntil: Date | null;
  }): Promise<CommentMute> {
    const trimmed = input.reason.trim();
    if (trimmed.length === 0) {
      throw AppError.badRequest('Begründung darf nicht leer sein.', 'EMPTY_REASON');
    }
    if (trimmed.length > 500) {
      throw AppError.badRequest('Begründung zu lang (max. 500 Zeichen).', 'REASON_TOO_LONG');
    }
    // Existenz-Check VOR INSERT — sonst kracht der FK-Constraint mit
    // einem 500. Ein 404 ist hier die ehrlichere Antwort an den Mod.
    const userExists = await persistence.database.query(
      `SELECT 1 FROM public."user" WHERE id = $1::uuid`,
      [input.userId]
    );
    if (userExists.rowCount === 0) {
      throw AppError.notFound('User nicht gefunden.', 'USER_NOT_FOUND');
    }
    const res = await persistence.database.query<CommentMute>(
      `INSERT INTO public."comment_mute" (user_id, reason, muted_by_user_id, muted_until)
       VALUES ($1::uuid, $2, $3::uuid, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET reason = EXCLUDED.reason,
             muted_by_user_id = EXCLUDED.muted_by_user_id,
             muted_until = EXCLUDED.muted_until
       RETURNING user_id AS "userId",
                 reason,
                 muted_by_user_id AS "mutedByUserId",
                 muted_until AS "mutedUntil",
                 created_at AS "createdAt"`,
      [input.userId, trimmed, input.moderatorId, input.mutedUntil]
    );
    return res.rows[0];
  }

  async unmute(userId: string): Promise<boolean> {
    const res = await persistence.database.query(
      `DELETE FROM public."comment_mute" WHERE user_id = $1::uuid`,
      [userId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Liste aller aktiven Mutes — für die Moderations-Übersicht. */
  async listMutes(): Promise<(CommentMute & {
    userName: string;
    userDisplayName: string | null;
    userAvatarUrl: string | null;
    userDeletedAt: Date | null;
  })[]> {
    const res = await persistence.database.query(
      `SELECT
         cm.user_id AS "userId",
         cm.reason,
         cm.muted_by_user_id AS "mutedByUserId",
         cm.muted_until AS "mutedUntil",
         cm.created_at AS "createdAt",
         u.name AS "userName",
         u.display_name AS "userDisplayName",
         u.avatar_url AS "userAvatarUrl",
         u.deleted_at AS "userDeletedAt"
       FROM public."comment_mute" cm
       JOIN public."user" u ON u.id = cm.user_id
       WHERE cm.muted_until IS NULL OR cm.muted_until > NOW()
       ORDER BY cm.created_at DESC`
    );
    return res.rows;
  }

  // ─── Internes Helper ───────────────────────────────────────────────

  private async getRawForDelete(commentId: string): Promise<{
    userId: string;
    deletedAt: Date | null;
    deletionReason: string | null;
  } | null> {
    const res = await persistence.database.query<{
      userId: string;
      deletedAt: Date | null;
      deletionReason: string | null;
    }>(
      `SELECT user_id AS "userId",
              deleted_at AS "deletedAt",
              deletion_reason AS "deletionReason"
       FROM public."comment"
       WHERE id = $1::uuid`,
      [commentId]
    );
    return res.rows[0] ?? null;
  }
}

const commentService = new CommentService();
export default commentService;
