import { Request, Response, NextFunction } from 'express';
import {
  clip as clipService,
  awardCategory as awardCategoryService,
  twitchCategory as twitchCategoryService,
  settings as settingsService
} from '../services/index.js';
import clipReportService from '../services/clip-report.js';
import {
  readForYouSettings,
  SETTING_FORYOU_W_MATCHING,
  SETTING_FORYOU_W_QUALITY,
  SETTING_FORYOU_W_RECENCY,
  SETTING_FORYOU_RECENCY_DAYS,
  SETTING_FORYOU_FRESH_DAYS,
  SETTING_FORYOU_MIN_SCORE
} from '../services/foryou-settings.js';
import AppError, { AppError as AppErrorClass } from '../services/error.js';
import type { ClipStatus, ClipReportStatus, ClipSection } from '../models/index.js';

const SETTING_DAILY_LIMIT = 'clips.auto_approve_daily_limit';
const SETTING_REQUIRE_ALL = 'clips.require_review_all';
const SETTING_REVIEW_SECTIONS = 'clips.review_sections';

/** Aktuelle Moderations-Einstellungen mit Defaults (für GET und PUT-Antwort). */
async function readModerationSettings(): Promise<{
  autoApproveDailyLimit: number;
  requireReviewAll: boolean;
  reviewSections: string[];
}> {
  const [autoApproveDailyLimit, requireReviewAll, reviewSections] = await Promise.all([
    settingsService.getSettingValue<number>(SETTING_DAILY_LIMIT, 5),
    settingsService.getSettingValue<boolean>(SETTING_REQUIRE_ALL, false),
    settingsService.getSettingValue<string[]>(SETTING_REVIEW_SECTIONS, [])
  ]);
  return { autoApproveDailyLimit, requireReviewAll, reviewSections };
}


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
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
    const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const rows = await clipService.listForModeration(statuses, limit, offset);
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

/**
 * Validiert die `status` + `rejectionReason`-Felder, die sowohl
 * `setStatus` (Einzel-Update) als auch `bulkModerate` (Bulk-Update) aus
 * dem Body lesen. Liefert das Tupel zurück oder gibt einen Validierungs-
 * Fehler über `next` ab und returnt `null`.
 */
function parseStatusUpdate(
  body: Record<string, unknown>,
  next: NextFunction
): { status: ClipStatus; rejectionReason: string | null } | null {
  if (typeof body.status !== 'string' || !VALID_CLIP_STATUSES.includes(body.status as ClipStatus)) {
    next(AppError.badRequest(`status muss einer von: ${VALID_CLIP_STATUSES.join(', ')} sein.`, 'BAD_STATUS'));
    return null;
  }
  let rejectionReason: string | null = null;
  const reasonRaw = body.rejectionReason;
  if (reasonRaw !== undefined && reasonRaw !== null && reasonRaw !== '') {
    if (typeof reasonRaw !== 'string' || reasonRaw.length > 500) {
      next(AppError.badRequest('rejectionReason muss String ≤ 500 Zeichen sein.', 'BAD_REASON'));
      return null;
    }
    rejectionReason = reasonRaw.trim();
  }
  return { status: body.status as ClipStatus, rejectionReason };
}

/**
 * POST /clips/bulk-moderate — Body: { ids: string[], status, rejectionReason? }
 * Setzt mehrere Clips in einem Rutsch auf denselben Status. UI-Komfort
 * für lange Queues; Limit ist 100 pro Request, damit ein Tippfehler die
 * DB nicht in einen Stoßstand schickt.
 *
 * Wir loopen bewusst über `clipService.setStatus` statt eine
 * `UPDATE … WHERE id = ANY` zu fahren — der Service-Pfad bleibt damit
 * die single source of truth (Validierung, Audit, etc.). Bei N ≤ 100
 * ist der Mehraufwand vernachlässigbar.
 */
const bulkModerate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return next(AppError.badRequest('ids muss ein nicht-leeres Array sein.', 'BAD_IDS'));
    }
    if (body.ids.length > 100) {
      return next(AppError.badRequest('Maximal 100 Clips pro Bulk-Aktion.', 'TOO_MANY_IDS'));
    }
    if (body.ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
      return next(AppError.badRequest('Alle ids müssen UUIDs sein.', 'BAD_UUID'));
    }
    const parsed = parseStatusUpdate(body, next);
    if (!parsed) return;

    const ids = [...new Set(body.ids as string[])];
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of ids) {
      try {
        await clipService.setStatus(id, parsed.status, parsed.rejectionReason);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({
          id,
          ok: false,
          error: err instanceof Error ? err.message : 'unknown'
        });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    return res.status(200).json({ total: results.length, ok: okCount, results });
  } catch (err) {
    return next(err);
  }
};

/** PATCH /clips/:id — Body: { status, rejectionReason? } */
const setStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = assertUuid(req.params.id, 'id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseStatusUpdate(body, next);
    if (!parsed) return;
    const updated = await clipService.setStatus(id, parsed.status, parsed.rejectionReason);
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
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
    const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    return res.status(200).json(await clipReportService.list(status, limit, offset));
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

// ─── Moderations-Einstellungen ────────────────────────────────────────────────

/** GET /moderation-settings */
const getModerationSettings = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    return res.status(200).json(await readModerationSettings());
  } catch (err) {
    return next(err);
  }
};

/**
 * PUT /moderation-settings — Body (alle optional):
 * { autoApproveDailyLimit, requireReviewAll, reviewSections }
 */
const updateModerationSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const body = (req.body ?? {}) as {
      autoApproveDailyLimit?: unknown;
      requireReviewAll?: unknown;
      reviewSections?: unknown;
    };

    if (body.autoApproveDailyLimit !== undefined) {
      const n = body.autoApproveDailyLimit;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1000) {
        return next(AppError.badRequest('autoApproveDailyLimit muss eine ganze Zahl 0–1000 sein.', 'BAD_LIMIT'));
      }
      await settingsService.upsertSetting(SETTING_DAILY_LIMIT, { value: n, updatedBy: userId });
    }

    if (body.requireReviewAll !== undefined) {
      if (typeof body.requireReviewAll !== 'boolean') {
        return next(AppError.badRequest('requireReviewAll muss boolean sein.', 'BAD_TOGGLE'));
      }
      await settingsService.upsertSetting(SETTING_REQUIRE_ALL, { value: body.requireReviewAll, updatedBy: userId });
    }

    if (body.reviewSections !== undefined) {
      const list = body.reviewSections;
      if (!Array.isArray(list) || list.some((s) => !VALID_SECTIONS.includes(s as ClipSection))) {
        return next(AppError.badRequest(`reviewSections muss ein Array gültiger Sektionen sein: ${VALID_SECTIONS.join(', ')}.`, 'BAD_SECTIONS'));
      }
      await settingsService.upsertSetting(SETTING_REVIEW_SECTIONS, { value: [...new Set(list)], updatedBy: userId });
    }

    return res.status(200).json(await readModerationSettings());
  } catch (err) {
    return next(err);
  }
};

// ─── „Für dich"-Algorithmus-Einstellungen ─────────────────────────────────────

/** GET /foryou-settings */
const getForYouSettings = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    return res.status(200).json(await readForYouSettings());
  } catch (err) {
    return next(err);
  }
};

/**
 * Helper: validiert einen Slider-Wert (0 … 1). Setter-Pattern wie bei
 * den Moderations-Einstellungen.
 */
function validateWeight(value: unknown, field: string): number | AppErrorClass {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return AppError.badRequest(`${field} muss eine Zahl 0…1 sein.`, 'BAD_WEIGHT');
  }
  return value;
}

function validateIntInRange(value: unknown, field: string, min: number, max: number): number | AppErrorClass {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return AppError.badRequest(`${field} muss eine ganze Zahl ${min}…${max} sein.`, 'BAD_RANGE');
  }
  return value;
}

/**
 * PUT /foryou-settings — Body (alle optional):
 * { weightMatching, weightQuality, weightRecency,
 *   recencyWindowDays, freshnessPoolDays, minPositiveScore }
 */
const updateForYouSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const updates: { key: string; value: number }[] = [];
    const tryWeight = (bodyKey: string, settingKey: string) => {
      if (body[bodyKey] === undefined) return null;
      const v = validateWeight(body[bodyKey], bodyKey);
      if (v instanceof AppErrorClass) return v;
      updates.push({ key: settingKey, value: v });
      return null;
    };
    const tryInt = (bodyKey: string, settingKey: string, min: number, max: number) => {
      if (body[bodyKey] === undefined) return null;
      const v = validateIntInRange(body[bodyKey], bodyKey, min, max);
      if (v instanceof AppErrorClass) return v;
      updates.push({ key: settingKey, value: v });
      return null;
    };

    const errs = [
      tryWeight('weightMatching', SETTING_FORYOU_W_MATCHING),
      tryWeight('weightQuality', SETTING_FORYOU_W_QUALITY),
      tryWeight('weightRecency', SETTING_FORYOU_W_RECENCY),
      tryInt('recencyWindowDays', SETTING_FORYOU_RECENCY_DAYS, 1, 365),
      tryInt('freshnessPoolDays', SETTING_FORYOU_FRESH_DAYS, 1, 90),
      tryInt('minPositiveScore', SETTING_FORYOU_MIN_SCORE, 1, 5)
    ];
    for (const e of errs) if (e !== null) return next(e);

    for (const u of updates) {
      await settingsService.upsertSetting(u.key, { value: u.value, updatedBy: userId });
    }
    return res.status(200).json(await readForYouSettings());
  } catch (err) {
    return next(err);
  }
};

export default {
  moderationQueue,
  setStatus,
  bulkModerate,
  listAwards,
  createAward,
  updateAward,
  removeAward,
  listReports,
  resolveReport,
  listCategories,
  setCategorySection,
  getModerationSettings,
  updateModerationSettings,
  getForYouSettings,
  updateForYouSettings
};
