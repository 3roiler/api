import { Request, Response, NextFunction } from 'express';
import commentService from '../services/comment.js';
import userService from '../services/user.js';
import { blog as blogService } from '../services/index.js';
import AppError from '../services/error.js';
import type { CommentTargetType } from '../models/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUser(req: Request): string {
  if (!req.userId) throw AppError.unauthorized('Anmeldung erforderlich.');
  return req.userId;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(`\`${field}\` muss eine UUID sein.`, 'BAD_UUID');
  }
  return value;
}

async function isModerator(userId: string): Promise<boolean> {
  const perms = await userService.getPermissions(userId);
  return perms.includes('clips.moderate') || perms.includes('admin.manage');
}

/* ─── Clip-Comments ────────────────────────────────────────────────── */

/** GET /clips/:id/comments — PUBLIC. Kommentare flach sortiert nach createdAt. */
const listClipComments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clipId = assertUuid(req.params.id, 'id');
    const rows = await commentService.listForTarget('clip', clipId);
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

/** POST /clips/:id/comments — AUTH. Body: { body, timestampSeconds?, parentCommentId? } */
const createClipComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const clipId = assertUuid(req.params.id, 'id');
    const body = (req.body ?? {}) as {
      body?: unknown;
      timestampSeconds?: unknown;
      parentCommentId?: unknown;
    };

    if (typeof body.body !== 'string') {
      return next(AppError.badRequest('`body` ist erforderlich.', 'MISSING_BODY'));
    }

    let timestampSeconds: number | null = null;
    if (body.timestampSeconds !== undefined && body.timestampSeconds !== null) {
      if (typeof body.timestampSeconds !== 'number' || !Number.isFinite(body.timestampSeconds)) {
        return next(AppError.badRequest('timestampSeconds muss eine Zahl sein.', 'BAD_TIMESTAMP'));
      }
      timestampSeconds = body.timestampSeconds;
    }

    let parentCommentId: string | null = null;
    if (body.parentCommentId !== undefined && body.parentCommentId !== null) {
      if (typeof body.parentCommentId !== 'string' || !UUID_RE.test(body.parentCommentId)) {
        return next(AppError.badRequest('parentCommentId muss eine UUID sein.', 'BAD_UUID'));
      }
      parentCommentId = body.parentCommentId;
    }

    const bypassCooldown = await isModerator(userId);
    const comment = await commentService.create({
      targetType: 'clip',
      targetId: clipId,
      userId,
      body: body.body,
      timestampSeconds,
      parentCommentId,
      bypassCooldown
    });
    return res.status(201).json(comment);
  } catch (err) {
    return next(err);
  }
};

/* ─── Blog-Comments ────────────────────────────────────────────────── */

/** GET /blog/:slug/comments — PUBLIC. */
const listBlogComments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug ?? '');
    if (slug.length === 0) {
      return next(AppError.badRequest('slug fehlt.', 'MISSING_SLUG'));
    }
    const post = await blogService.getPostBySlug(slug, { viewerId: null });
    if (!post) {
      return next(AppError.notFound('Beitrag nicht gefunden.', 'POST_NOT_FOUND'));
    }
    const rows = await commentService.listForTarget('blog_post', post.id);
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

/** POST /blog/:slug/comments — AUTH. Body: { body, parentCommentId? } */
const createBlogComment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const slug = String(req.params.slug ?? '');
    if (slug.length === 0) {
      return next(AppError.badRequest('slug fehlt.', 'MISSING_SLUG'));
    }
    const post = await blogService.getPostBySlug(slug, { viewerId: userId });
    if (!post) {
      return next(AppError.notFound('Beitrag nicht gefunden.', 'POST_NOT_FOUND'));
    }
    // Drafts/private posts: nur Autoren/Berechtigte können dort schreiben.
    if (post.publishedAt === null) {
      return next(AppError.forbidden('Beitrag ist nicht veröffentlicht.', 'POST_DRAFT'));
    }

    const body = (req.body ?? {}) as { body?: unknown; parentCommentId?: unknown };
    if (typeof body.body !== 'string') {
      return next(AppError.badRequest('`body` ist erforderlich.', 'MISSING_BODY'));
    }
    let parentCommentId: string | null = null;
    if (body.parentCommentId !== undefined && body.parentCommentId !== null) {
      if (typeof body.parentCommentId !== 'string' || !UUID_RE.test(body.parentCommentId)) {
        return next(AppError.badRequest('parentCommentId muss eine UUID sein.', 'BAD_UUID'));
      }
      parentCommentId = body.parentCommentId;
    }

    const bypassCooldown = await isModerator(userId);
    const comment = await commentService.create({
      targetType: 'blog_post',
      targetId: post.id,
      userId,
      body: body.body,
      timestampSeconds: null,
      parentCommentId,
      bypassCooldown
    });
    return res.status(201).json(comment);
  } catch (err) {
    return next(err);
  }
};

/* ─── Shared: löschen, moderate-delete, restore ────────────────────── */

/** DELETE /comments/:id — AUTH. Eigene → soft-delete. Mod auf fremde
 *  Kommentare ist hier nicht erlaubt; Transparenz-Grund kommt über
 *  PATCH /moderate. Wir versuchen direkt `deleteOwn` — der Service
 *  wirft 403 wenn der Aufrufer nicht der Autor ist. Mods bekommen
 *  einen klareren 400 statt 403, damit der UI-Hinweis auf
 *  /moderate spezifisch ist (statt „verboten" generisch). */
const remove = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const commentId = assertUuid(req.params.id, 'id');
    try {
      await commentService.deleteOwn(commentId, userId);
      return res.status(204).send();
    } catch (err) {
      // Eigener Kommentar des Mods? deleteOwn ist eh durch. Sonst
      // ersetzen wir die generische COMMENT_FORBIDDEN-Antwort durch
      // einen sprechenderen Hinweis auf den Mod-Pfad.
      if (err instanceof AppError.AppError && err.identifier === 'COMMENT_FORBIDDEN') {
        const mod = await isModerator(userId);
        if (mod) {
          return next(AppError.badRequest(
            'Moderator-Löschungen brauchen einen Grund — nutze PATCH /moderate.',
            'MOD_DELETE_NEEDS_REASON'
          ));
        }
      }
      throw err;
    }
  } catch (err) {
    return next(err);
  }
};

/** PATCH /comments/:id/moderate — AUTH + clips.moderate. Body: { reason }. */
const moderateDelete = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    if (!(await isModerator(userId))) {
      return next(AppError.forbidden('Nur Moderatoren.', 'NOT_MODERATOR'));
    }
    const commentId = assertUuid(req.params.id, 'id');
    const body = (req.body ?? {}) as { reason?: unknown };
    if (typeof body.reason !== 'string') {
      return next(AppError.badRequest('reason ist erforderlich.', 'MISSING_REASON'));
    }
    await commentService.deleteAsModerator(commentId, userId, body.reason);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

/** PATCH /comments/:id/restore — AUTH + clips.moderate. */
const restore = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    if (!(await isModerator(userId))) {
      return next(AppError.forbidden('Nur Moderatoren.', 'NOT_MODERATOR'));
    }
    const commentId = assertUuid(req.params.id, 'id');
    await commentService.restore(commentId);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

/* ─── Mute (Admin) ─────────────────────────────────────────────────── */

/** GET /admin/streamclips/mutes — AUTH + clips.moderate. */
const listMutes = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    if (!(await isModerator(userId))) {
      return next(AppError.forbidden('Nur Moderatoren.', 'NOT_MODERATOR'));
    }
    const rows = await commentService.listMutes();
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

/** POST /admin/streamclips/users/:id/mute — Body: { reason, mutedUntil? } */
const muteUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const moderatorId = requireUser(req);
    if (!(await isModerator(moderatorId))) {
      return next(AppError.forbidden('Nur Moderatoren.', 'NOT_MODERATOR'));
    }
    const targetUserId = assertUuid(req.params.id, 'id');
    const body = (req.body ?? {}) as { reason?: unknown; mutedUntil?: unknown };
    if (typeof body.reason !== 'string') {
      return next(AppError.badRequest('reason ist erforderlich.', 'MISSING_REASON'));
    }
    let mutedUntil: Date | null = null;
    if (body.mutedUntil !== undefined && body.mutedUntil !== null && body.mutedUntil !== '') {
      if (typeof body.mutedUntil !== 'string') {
        return next(AppError.badRequest('mutedUntil muss ISO-8601 String sein.', 'BAD_DATE'));
      }
      const d = new Date(body.mutedUntil);
      if (Number.isNaN(d.getTime())) {
        return next(AppError.badRequest('mutedUntil ist kein gültiges Datum.', 'BAD_DATE'));
      }
      mutedUntil = d;
    }
    const result = await commentService.mute({
      userId: targetUserId,
      moderatorId,
      reason: body.reason,
      mutedUntil
    });
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};

/** DELETE /admin/streamclips/users/:id/mute */
const unmuteUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    if (!(await isModerator(userId))) {
      return next(AppError.forbidden('Nur Moderatoren.', 'NOT_MODERATOR'));
    }
    const targetUserId = assertUuid(req.params.id, 'id');
    await commentService.unmute(targetUserId);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

export default {
  listClipComments,
  createClipComment,
  listBlogComments,
  createBlogComment,
  remove,
  moderateDelete,
  restore,
  listMutes,
  muteUser,
  unmuteUser
};

// Re-export für Cross-Route-Verwendung (z. B. wenn der unmuteUser-Type
// hinaus muss).
export type CommentControllerTargetType = CommentTargetType;
