import { Request, Response, NextFunction } from 'express';
import clipCommentService from '../services/clip-comment.js';
import userService from '../services/user.js';
import AppError from '../services/error.js';

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

/** GET /clips/:id/comments — PUBLIC. Liefert alle nicht-gelöschten
 *  Kommentare in chronologischer Reihenfolge (älteste zuerst). */
const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clipId = assertUuid(req.params.id, 'id');
    const comments = await clipCommentService.listForClip(clipId);
    return res.status(200).json(comments);
  } catch (err) {
    return next(err);
  }
};

/** POST /clips/:id/comments — AUTH. Body: { body, timestampSeconds? } */
const create = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const clipId = assertUuid(req.params.id, 'id');
    const body = (req.body ?? {}) as { body?: unknown; timestampSeconds?: unknown };

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

    const comment = await clipCommentService.create(clipId, userId, body.body, timestampSeconds);
    return res.status(201).json(comment);
  } catch (err) {
    return next(err);
  }
};

/** DELETE /comments/:id — AUTH. Soft-Delete (eigene Kommentare, oder
 *  jegliche wenn der User `clips.moderate` hat). */
const remove = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const commentId = assertUuid(req.params.id, 'id');
    const permissions = await userService.getPermissions(userId);
    const isModerator =
      permissions.includes('clips.moderate') || permissions.includes('admin.manage');
    await clipCommentService.delete(commentId, userId, isModerator);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

export default { list, create, remove };
