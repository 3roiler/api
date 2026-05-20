import { Request, Response, NextFunction } from 'express';
import {
  clip as clipService,
  awardCategory as awardCategoryService,
  twitchCategory as twitchCategoryService
} from '../services/index.js';
import clipReportService from '../services/clip-report.js';
import AppError from '../services/error.js';
import type { ClipStatus, ClipReportStatus, ClipSection } from '../models/index.js';

const VALID_SECTIONS: ClipSection[] = [
  'gaming', 'just_chatting', 'irl', 'music', 'esports', 'creative', 'other'
];

const KEY_MAX = 40;
const NAME_MAX = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z][a-z0-9_]{1,38}[a-z0-9]$/;

const VALID_CLIP_STATUSES: ClipStatus[] = ['pending', 'approved', 'rejected', 'flagged'];
const VALID_REPORT_STATUSES: ClipReportStatus[] = ['open', 'resolved', 'dismissed'];

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

// ─── Moderations-Queue ──────────────────────────────────────────────────────

/** GET /clips?status=pending,flagged */
const moderationQueue = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let statuses: ClipStatus[] = ['pending'];
    if (typeof req.query.status === 'string' && req.query.status.length > 0) {
      const tokens = req.query.status.split(',').map((s) => s.trim()).filter(Boolean);
      const invalid = tokens.filter((t) => !VALID_CLIP_STATUSES.includes(t as ClipStatus));
      if (invalid.length > 0) {
        return next(AppError.badRequest(`Unbekannter status-Filter: ${invalid.join(', ')}.`, 'BAD_STATUS_FILTER'));
      }
      statuses = tokens as ClipStatus[];
    }
    const rows = await clipService.listForModeration(statuses);
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

/** PATCH /clips/:id — Body: { status, rejectionReason? } */
const setStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = assertUuid(req.params.id, 'id');
    const body = (req.body ?? {}) as { status?: unknown; rejectionReason?: unknown };
    if (typeof body.status !== 'string' || !VALID_CLIP_STATUSES.includes(body.status as ClipStatus)) {
      return next(AppError.badRequest(`status muss einer von: ${VALID_CLIP_STATUSES.join(', ')} sein.`, 'BAD_STATUS'));
    }
    let rejectionReason: string | null = null;
    if (body.rejectionReason !== undefined && body.rejectionReason !== null && body.rejectionReason !== '') {
      if (typeof body.rejectionReason !== 'string' || body.rejectionReason.length > 500) {
        return next(AppError.badRequest('rejectionReason muss String ≤ 500 Zeichen sein.', 'BAD_REASON'));
      }
      rejectionReason = body.rejectionReason.trim();
    }
    const updated = await clipService.setStatus(id, body.status as ClipStatus, rejectionReason);
    return res.status(200).json(updated);
  } catch (err) {
    return next(err);
  }
};

// ─── Award-Kategorien (CRUD) ──────────────────────────────────────────────────

/** GET /awards — alle (auch inaktive). */
const listAwards = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    return res.status(200).json(await awardCategoryService.listAll());
  } catch (err) {
    return next(err);
  }
};

/** POST /awards — Body: { key, displayName, description?, emoji?, color?, sortOrder? } */
const createAward = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.key !== 'string' || !KEY_RE.test(body.key) || body.key.length > KEY_MAX) {
      return next(AppError.badRequest('key muss klein-alphanumerisch mit _ sein (z.B. "best_play").', 'BAD_KEY'));
    }
    if (typeof body.displayName !== 'string' || body.displayName.trim().length === 0 || body.displayName.length > NAME_MAX) {
      return next(AppError.badRequest(`displayName muss 1–${NAME_MAX} Zeichen sein.`, 'BAD_DISPLAY_NAME'));
    }
    const created = await awardCategoryService.create({
      key: body.key,
      displayName: body.displayName.trim(),
      description: typeof body.description === 'string' ? body.description.trim() : null,
      emoji: typeof body.emoji === 'string' ? body.emoji : null,
      color: typeof body.color === 'string' ? body.color : null,
      sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0
    });
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
};

/** PATCH /awards/:id — partielle Aktualisierung. */
const updateAward = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = assertUuid(req.params.id, 'id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = await awardCategoryService.update(id, {
      displayName: typeof body.displayName === 'string' ? body.displayName.trim() : undefined,
      description: body.description === null ? null : typeof body.description === 'string' ? body.description.trim() : undefined,
      emoji: body.emoji === null ? null : typeof body.emoji === 'string' ? body.emoji : undefined,
      color: body.color === null ? null : typeof body.color === 'string' ? body.color : undefined,
      isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
      sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined
    });
    return res.status(200).json(updated);
  } catch (err) {
    return next(err);
  }
};

/** DELETE /awards/:id */
const removeAward = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = assertUuid(req.params.id, 'id');
    const ok = await awardCategoryService.remove(id);
    if (!ok) return next(AppError.notFound('Award-Kategorie nicht gefunden.', 'AWARD_NOT_FOUND'));
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

// ─── Meldungen ────────────────────────────────────────────────────────────────

/** GET /reports?status=open */
const listReports = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let status: ClipReportStatus = 'open';
    if (typeof req.query.status === 'string' && req.query.status.length > 0) {
      if (!VALID_REPORT_STATUSES.includes(req.query.status as ClipReportStatus)) {
        return next(AppError.badRequest(`Unbekannter status: ${req.query.status}.`, 'BAD_STATUS_FILTER'));
      }
      status = req.query.status as ClipReportStatus;
    }
    return res.status(200).json(await clipReportService.list(status));
  } catch (err) {
    return next(err);
  }
};

/** PATCH /reports/:id — Body: { status: 'resolved' | 'dismissed' } */
const resolveReport = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const id = assertUuid(req.params.id, 'id');
    const body = (req.body ?? {}) as { status?: unknown };
    if (body.status !== 'resolved' && body.status !== 'dismissed') {
      return next(AppError.badRequest("status muss 'resolved' oder 'dismissed' sein.", 'BAD_STATUS'));
    }
    const updated = await clipReportService.resolve(id, userId, body.status);
    return res.status(200).json(updated);
  } catch (err) {
    return next(err);
  }
};

// ─── Twitch-Kategorien → Sektion ──────────────────────────────────────────────

/** GET /categories — alle Twitch-Kategorien inkl. Clip-Anzahl. */
const listCategories = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    return res.status(200).json(await twitchCategoryService.listAll());
  } catch (err) {
    return next(err);
  }
};

/** PATCH /categories/:id — Body: { section }. id = Twitch game_id (varchar). */
const setCategorySection = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      return next(AppError.badRequest('Kategorie-ID fehlt.', 'BAD_CATEGORY_ID'));
    }
    const body = (req.body ?? {}) as { section?: unknown };
    if (typeof body.section !== 'string' || !VALID_SECTIONS.includes(body.section as ClipSection)) {
      return next(AppError.badRequest(`section muss einer von: ${VALID_SECTIONS.join(', ')} sein.`, 'BAD_SECTION'));
    }
    const updated = await twitchCategoryService.setSection(id, body.section as ClipSection);
    return res.status(200).json(updated);
  } catch (err) {
    return next(err);
  }
};

export default {
  moderationQueue,
  setStatus,
  listAwards,
  createAward,
  updateAward,
  removeAward,
  listReports,
  resolveReport,
  listCategories,
  setCategorySection
};
