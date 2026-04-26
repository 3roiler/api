import { Request, Response, NextFunction } from 'express';
import { printRequest as printRequestService } from '../services/index.js';
import userService from '../services/user.js';
import AppError from '../services/error.js';
import type { PrintRequestStatus, PrintRequestSourceType } from '../models/index.js';

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;
const URL_MAX = 2048;
const COMMENT_MAX = 4000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES: PrintRequestStatus[] = [
  'new', 'accepted', 'printing', 'done', 'rejected', 'cancelled'
];
const VALID_SOURCE_TYPES: PrintRequestSourceType[] = ['stl_upload', 'external_link'];

function requireUser(req: Request): string {
  if (!req.userId) throw AppError.unauthorized('No authenticated user.');
  return req.userId;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(`\`${field}\` must be a UUID.`, 'BAD_UUID');
  }
  return value;
}

/**
 * Lightweight URL gate. Same shape as the profile-link validator —
 * http(s) only, length-capped. We don't try to fetch the URL or
 * verify it points at a real model; the moderator does that during
 * review.
 */
function isValidHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > URL_MAX) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function isModerator(userId: string): Promise<boolean> {
  const perms = await userService.getPermissions(userId);
  return perms.includes('print.moderate') || perms.includes('admin.manage');
}

/**
 * POST /api/print-request
 *   Body: { title, description?, sourceType, stlFileId?, externalUrl? }
 *
 * Anyone with `print.request` (or `print.moderate`, since admins can
 * file too) can submit. The route gate enforces that.
 */
const create = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const body = (req.body ?? {}) as {
      title?: unknown;
      description?: unknown;
      sourceType?: unknown;
      stlFileId?: unknown;
      externalUrl?: unknown;
    };

    if (typeof body.title !== 'string' || body.title.trim().length === 0 || body.title.length > TITLE_MAX) {
      return next(AppError.badRequest(`title muss 1–${TITLE_MAX} Zeichen sein.`, 'BAD_TITLE'));
    }
    let description: string | null = null;
    if (body.description !== undefined && body.description !== null && body.description !== '') {
      if (typeof body.description !== 'string' || body.description.length > DESCRIPTION_MAX) {
        return next(AppError.badRequest(
          `description muss String ≤ ${DESCRIPTION_MAX} Zeichen sein.`,
          'BAD_DESCRIPTION'
        ));
      }
      description = body.description.trim();
    }

    if (typeof body.sourceType !== 'string' || !VALID_SOURCE_TYPES.includes(body.sourceType as PrintRequestSourceType)) {
      return next(AppError.badRequest(
        `sourceType muss einer von: ${VALID_SOURCE_TYPES.join(', ')} sein.`,
        'BAD_SOURCE_TYPE'
      ));
    }

    let source:
      | { type: 'stl_upload'; stlFileId: string }
      | { type: 'external_link'; externalUrl: string };
    if (body.sourceType === 'stl_upload') {
      const stlFileId = assertUuid(body.stlFileId, 'stlFileId');
      source = { type: 'stl_upload', stlFileId };
    } else {
      if (typeof body.externalUrl !== 'string' || !isValidHttpUrl(body.externalUrl.trim())) {
        return next(AppError.badRequest('externalUrl muss eine gültige http(s)-URL sein.', 'BAD_URL'));
      }
      source = { type: 'external_link', externalUrl: body.externalUrl.trim() };
    }

    const created = await printRequestService.create({
      requesterUserId: userId,
      title: body.title.trim(),
      description,
      source
    });
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/print-request
 *   Visibility:
 *     - moderator: all rows (optionally filter by ?mine=1)
 *     - non-moderator: only their own
 *   Filter: ?status=new,accepted,...
 */
const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const moderator = await isModerator(userId);
    const onlyMine = String(req.query.mine ?? '') === '1';
    const requesterUserId = !moderator || onlyMine ? userId : undefined;

    let status: PrintRequestStatus[] | undefined;
    if (typeof req.query.status === 'string' && req.query.status.length > 0) {
      const tokens = req.query.status.split(',').map((s) => s.trim()).filter(Boolean);
      const invalid = tokens.filter((t) => !VALID_STATUSES.includes(t as PrintRequestStatus));
      if (invalid.length > 0) {
        return next(AppError.badRequest(
          `Unbekannter status-Filter: ${invalid.join(', ')}.`,
          'BAD_STATUS_FILTER'
        ));
      }
      status = tokens as PrintRequestStatus[];
    }

    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
    const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

    const rows = await printRequestService.list({
      requesterUserId,
      status,
      limit,
      offset
    });
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

const getById = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const moderator = await isModerator(userId);

    const row = await printRequestService.getById(id);
    if (!row || (!moderator && row.requesterUserId !== userId)) {
      return next(AppError.notFound('Druckanfrage not found', 'PRINT_REQUEST_NOT_FOUND'));
    }

    const comments = await printRequestService.listComments(id);
    return res.status(200).json({ ...row, comments });
  } catch (err) {
    return next(err);
  }
};

/**
 * PATCH /api/print-request/:id
 *   Body: { status?, assignedPrinterId? }
 *
 * Moderator only. The requester's own "cancel" goes through a
 * separate endpoint so the permission boundary stays sharp.
 */
const update = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    if (!(await isModerator(userId))) {
      return next(AppError.forbidden('Nur Moderatoren können Anfragen ändern.', 'NOT_MODERATOR'));
    }

    const { id } = req.params;
    const body = (req.body ?? {}) as {
      status?: unknown;
      assignedPrinterId?: unknown;
    };

    let status: PrintRequestStatus | undefined;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !VALID_STATUSES.includes(body.status as PrintRequestStatus)) {
        return next(AppError.badRequest(
          `status muss einer von: ${VALID_STATUSES.join(', ')} sein.`,
          'BAD_STATUS'
        ));
      }
      status = body.status as PrintRequestStatus;
    }

    let assignedPrinterId: string | null | undefined;
    if (body.assignedPrinterId !== undefined) {
      if (body.assignedPrinterId === null) {
        assignedPrinterId = null;
      } else {
        assignedPrinterId = assertUuid(body.assignedPrinterId, 'assignedPrinterId');
      }
    }

    const updated = await printRequestService.update(id, {
      status,
      assignedPrinterId
    });
    return res.status(200).json(updated);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/print-request/:id/cancel — requester withdraws their own
 * request. Moderators can also call this, but they normally use
 * `update` with status='rejected' or 'cancelled' depending on intent.
 */
const cancel = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const moderator = await isModerator(userId);

    const row = await printRequestService.getById(id);
    if (!row) {
      return next(AppError.notFound('Druckanfrage not found', 'PRINT_REQUEST_NOT_FOUND'));
    }
    if (!moderator && row.requesterUserId !== userId) {
      return next(AppError.forbidden('Nur eigene Anfragen können zurückgezogen werden.', 'NOT_OWN_REQUEST'));
    }

    const cancelled = await printRequestService.cancel(id);
    return res.status(200).json(cancelled);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/print-request/:id/comment
 *   Body: { body }
 *
 * Both requester and moderator can comment on the same thread. The
 * UI surfaces author name + role from the user join in the response.
 */
const addComment = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const moderator = await isModerator(userId);

    const row = await printRequestService.getById(id);
    if (!row || (!moderator && row.requesterUserId !== userId)) {
      return next(AppError.notFound('Druckanfrage not found', 'PRINT_REQUEST_NOT_FOUND'));
    }

    const body = (req.body ?? {}) as { body?: unknown };
    if (typeof body.body !== 'string' || body.body.trim().length === 0 || body.body.length > COMMENT_MAX) {
      return next(AppError.badRequest(
        `body muss String 1–${COMMENT_MAX} Zeichen sein.`,
        'BAD_BODY'
      ));
    }

    const comment = await printRequestService.addComment(id, userId, body.body.trim());
    return res.status(201).json(comment);
  } catch (err) {
    return next(err);
  }
};

export default {
  create,
  list,
  getById,
  update,
  cancel,
  addComment
};
