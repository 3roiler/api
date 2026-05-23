import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import AppError from './error.js';
import type { ClipComment, ClipCommentWithAuthor } from '../models/index.js';

/**
 * Kommentare auf Clips, optional mit Zeitstempel-Sprungmark.
 *
 * Design-Notes:
 *  - `body` ist Plaintext (max 2000 Zeichen). Kein Markdown-Rendering.
 *    Das Frontend lineariert Newlines (white-space: pre-wrap), bekommt
 *    Auto-Link für URLs und das war's.
 *  - Hard-Limit pro Clip ist im API nicht gesetzt — Moderatoren räumen
 *    bei Bedarf manuell auf (Soft-Delete).
 *  - Anti-Spam: 30 s Cooldown zwischen Kommentaren desselben Users
 *    auf demselben Clip. Bewusst sehr lasch — strenger Cooldown
 *    macht echte Diskussion mit Antwort + Korrektur unmöglich.
 */

// Aliased Variante für JOIN-Selects, Plain für `RETURNING` aus dem
// INSERT (das keinen Tabellen-Alias hat). Postgres würde sonst beim
// INSERT … RETURNING gegen `c.id` mit „missing FROM-clause entry"
// streiken.
const COMMENT_COLUMNS_ALIASED = `
  c.id,
  c.clip_id AS "clipId",
  c.user_id AS "userId",
  c.body,
  c.timestamp_seconds::float8 AS "timestampSeconds",
  c.deleted_at AS "deletedAt",
  c.deleted_by_user_id AS "deletedByUserId",
  c.created_at AS "createdAt",
  c.updated_at AS "updatedAt"
`;

const COMMENT_COLUMNS_PLAIN = `
  id,
  clip_id AS "clipId",
  user_id AS "userId",
  body,
  timestamp_seconds::float8 AS "timestampSeconds",
  deleted_at AS "deletedAt",
  deleted_by_user_id AS "deletedByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const COMMENT_WITH_AUTHOR_SELECT = `
  SELECT ${COMMENT_COLUMNS_ALIASED},
    u.name AS "authorName",
    u.display_name AS "authorDisplayName",
    u.avatar_url AS "authorAvatarUrl"
  FROM public."clip_comment" c
  JOIN public."user" u ON u.id = c.user_id
`;

export class ClipCommentService {
  /** Lädt alle nicht-gelöschten Kommentare zu einem Clip. */
  async listForClip(clipId: string): Promise<ClipCommentWithAuthor[]> {
    const result: QueryResult<ClipCommentWithAuthor> = await persistence.database.query(
      `${COMMENT_WITH_AUTHOR_SELECT}
       WHERE c.clip_id = $1::uuid AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC`,
      [clipId]
    );
    return result.rows;
  }

  /** Erstellt einen Kommentar. Wirft `RATE_LIMIT`, wenn der User
   *  unter 30 s davor schon auf diesem Clip gepostet hat. */
  async create(
    clipId: string,
    userId: string,
    body: string,
    timestampSeconds: number | null
  ): Promise<ClipComment> {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      throw AppError.badRequest('Kommentar darf nicht leer sein.', 'EMPTY_COMMENT');
    }
    if (trimmed.length > 2000) {
      throw AppError.badRequest('Kommentar zu lang (max. 2000 Zeichen).', 'COMMENT_TOO_LONG');
    }
    if (
      timestampSeconds !== null &&
      (!Number.isFinite(timestampSeconds) || timestampSeconds < 0)
    ) {
      throw AppError.badRequest('timestampSeconds muss ≥ 0 sein.', 'BAD_TIMESTAMP');
    }

    // 30 s Cooldown pro User & Clip — gegen unbeabsichtigtes Doppelposten
    // und Spam, aber locker genug für Diskussion.
    const recentRes: QueryResult<{ count: string }> = await persistence.database.query(
      `SELECT COUNT(*)::text AS count FROM public."clip_comment"
       WHERE clip_id = $1::uuid
         AND user_id = $2::uuid
         AND created_at >= NOW() - INTERVAL '30 seconds'
         AND deleted_at IS NULL`,
      [clipId, userId]
    );
    if (Number(recentRes.rows[0]?.count ?? 0) > 0) {
      throw AppError.tooManyRequests(
        'Bitte 30 Sekunden warten, bevor du erneut kommentierst.',
        'COMMENT_COOLDOWN'
      );
    }

    const result: QueryResult<ClipComment> = await persistence.database.query(
      `INSERT INTO public."clip_comment" (clip_id, user_id, body, timestamp_seconds)
       VALUES ($1::uuid, $2::uuid, $3, $4)
       RETURNING ${COMMENT_COLUMNS_PLAIN}`,
      [clipId, userId, trimmed, timestampSeconds]
    );
    return result.rows[0];
  }

  /** Soft-Delete. Eigene Kommentare darf jeder User löschen; fremde nur
   *  ein Moderator. Wirft `NOT_FOUND` wenn die ID nicht existiert oder
   *  bereits gelöscht ist; `FORBIDDEN` wenn der User keine Rechte hat. */
  async delete(
    commentId: string,
    actorUserId: string,
    actorIsModerator: boolean
  ): Promise<void> {
    const lookup: QueryResult<{ userId: string; deletedAt: Date | null }> =
      await persistence.database.query(
        `SELECT user_id AS "userId", deleted_at AS "deletedAt"
         FROM public."clip_comment"
         WHERE id = $1::uuid`,
        [commentId]
      );
    const row = lookup.rows[0];
    if (!row) {
      throw AppError.notFound('Kommentar nicht gefunden.', 'COMMENT_NOT_FOUND');
    }
    if (row.deletedAt !== null) {
      // Idempotent: schon gelöscht → kein Fehler, einfach durch.
      return;
    }
    const isAuthor = row.userId === actorUserId;
    if (!isAuthor && !actorIsModerator) {
      throw AppError.forbidden('Du darfst diesen Kommentar nicht löschen.', 'COMMENT_FORBIDDEN');
    }

    await persistence.database.query(
      `UPDATE public."clip_comment"
       SET deleted_at = NOW(), deleted_by_user_id = $2::uuid
       WHERE id = $1::uuid`,
      [commentId, actorUserId]
    );
  }
}

const clipCommentService = new ClipCommentService();
export default clipCommentService;
