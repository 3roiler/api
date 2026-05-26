import { Request, Response, NextFunction } from 'express';
import { clip as clipService, clipRating as clipRatingService } from '../services/index.js';
import clipReportService from '../services/clip-report.js';
import AppError from '../services/error.js';
import type { ClipSection } from '../models/index.js';

const URL_MAX = 2048;
const REASON_MAX = 500;
const MAX_AWARD_IDS = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_SECTIONS: ClipSection[] = [
  'gaming', 'just_chatting', 'irl', 'music', 'esports', 'creative', 'other'
];

/** Leaderboard-Zeiträume → Tage (undefined = Allzeit). */
const PERIOD_DAYS: Record<string, number | undefined> = { week: 7, month: 30, all: undefined };

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

function parseSection(raw: unknown): ClipSection | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw === 'string' && VALID_SECTIONS.includes(raw as ClipSection)) {
    return raw as ClipSection;
  }
  throw AppError.badRequest(`Unbekannte Sektion. Erlaubt: ${VALID_SECTIONS.join(', ')}.`, 'BAD_SECTION');
}

/**
 * POST /api/clips  — Body: { url }
 * Reicht einen Twitch-Clip ein (gated via `clips.submit` in der Route).
 */
const submit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const body = (req.body ?? {}) as { url?: unknown };
    if (typeof body.url !== 'string' || body.url.trim().length === 0 || body.url.length > URL_MAX) {
      return next(AppError.badRequest('url ist erforderlich (Twitch-Clip-Link oder -ID).', 'BAD_URL'));
    }
    const created = await clipService.submit(userId, body.url.trim());
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/clips/feed/next?section=  — der Zufalls-Feed.
 * Liefert `{ clip: null }`, wenn nichts mehr zu bewerten ist.
 */
const feedNext = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const section = parseSection(req.query.section);
    const clip = await clipService.getFeedNext(userId, { section });
    return res.status(200).json({ clip });
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/clips/:id/rating — Body: { score?, awardIds?, skipped? }
 * Score 1–5 ODER skipped (Enthaltung); nie beides.
 */
const rate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const clipId = assertUuid(req.params.id, 'id');
    const body = (req.body ?? {}) as { score?: unknown; awardIds?: unknown; skipped?: unknown };

    const skipped = body.skipped === true;

    let score: number | null = null;
    if (!skipped) {
      if (
        typeof body.score !== 'number' ||
        !Number.isInteger(body.score) ||
        body.score < 1 ||
        body.score > 5
      ) {
        return next(AppError.badRequest('score muss eine ganze Zahl 1–5 sein (oder skipped=true).', 'BAD_SCORE'));
      }
      score = body.score;
    }

    let awardIds: string[] = [];
    if (!skipped && body.awardIds !== undefined) {
      if (!Array.isArray(body.awardIds) || body.awardIds.length > MAX_AWARD_IDS) {
        return next(AppError.badRequest(`awardIds muss ein Array mit ≤ ${MAX_AWARD_IDS} UUIDs sein.`, 'BAD_AWARD_IDS'));
      }
      awardIds = body.awardIds.map((v, i) => assertUuid(v, `awardIds[${i}]`));
    }

    const rating = await clipRatingService.rate(userId, clipId, { score, awardIds, skipped });
    return res.status(200).json(rating);
  } catch (err) {
    return next(err);
  }
};

/** GET /api/clips/mine — eigene Einreichungen (alle Status). */
const mine = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const rows = await clipService.listMine(userId);
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

/** GET /api/clips/:id — Detail inkl. eigener Bewertung. */
const getById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clipId = assertUuid(req.params.id, 'id');
    const clip = await clipService.getById(clipId);
    if (!clip) return next(AppError.notFound('Clip nicht gefunden.', 'CLIP_NOT_FOUND'));
    // Öffentlich: ohne Login kein `myRating`. Bei optionalem Auth ist
    // `req.userId` gesetzt und wir liefern die eigene Bewertung mit.
    const myRating = req.userId
      ? await clipRatingService.getUserRating(req.userId, clipId)
      : null;
    return res.status(200).json({ ...clip, myRating });
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/clips/by-shortid/:shortid — Lookup über die URL-shortid
 * (= erste 8 Hex-Zeichen der UUID, Bindestriche entfernt). Treibt die
 * kanonische Slug-URL `/streamclips/clip/<slug>-<shortid>` im Frontend.
 *
 * Validierung passiert im Service (`/^[0-9a-f]{8}$/`); ungültige Werte
 * geben `null` zurück und enden hier in `CLIP_NOT_FOUND`.
 */
const getByShortid = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shortid = String(req.params.shortid ?? '');
    const clip = await clipService.getByShortid(shortid);
    if (!clip) return next(AppError.notFound('Clip nicht gefunden.', 'CLIP_NOT_FOUND'));
    const myRating = req.userId
      ? await clipRatingService.getUserRating(req.userId, clip.id)
      : null;
    return res.status(200).json({ ...clip, myRating });
  } catch (err) {
    return next(err);
  }
};

/** POST /api/clips/:id/report — Body: { reason }. */
const report = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const clipId = assertUuid(req.params.id, 'id');
    const body = (req.body ?? {}) as { reason?: unknown };
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0 || body.reason.length > REASON_MAX) {
      return next(AppError.badRequest(`reason muss 1–${REASON_MAX} Zeichen sein.`, 'BAD_REASON'));
    }
    const created = await clipReportService.create(clipId, userId, body.reason.trim());
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/clips/leaderboard?section=&limit=  — PUBLIC (kein Login).
 * Top-Clips per Bayesian-Average, optional auf eine Sektion gefiltert.
 */
const leaderboard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const section = parseSection(req.query.section);
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);

    let periodDays: number | undefined;
    const periodRaw = req.query.period;
    if (typeof periodRaw === 'string' && periodRaw.length > 0) {
      if (!(periodRaw in PERIOD_DAYS)) {
        return next(AppError.badRequest('period muss week, month oder all sein.', 'BAD_PERIOD'));
      }
      periodDays = PERIOD_DAYS[periodRaw];
    }

    const rows = await clipService.leaderboard({ section, limit, periodDays });
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/clips/browse — PUBLIC. Liefert die freigegebenen Clips zweimal
 * gruppiert: nach Twitch-Kategorie und nach Award-Label (für die
 * Laufband-Reihen auf der Startseite).
 */
const browse = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await clipService.browse();
    return res.status(200).json(data);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/clips/search?q= — PUBLIC. Volltextsuche über Titel, Einreicher,
 * Broadcaster, Kategorie und Award-Labels. Leeres/zu kurzes q → [].
 */
const search = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const rows = await clipService.search(q);
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/clips/by-broadcaster/:broadcasterId?excludeId=&limit= — PUBLIC.
 * Weitere freigegebene Clips desselben Twitch-Broadcasters. Genutzt für
 * das „Mehr von diesem Streamer"-Karussell auf der Clip-Detailseite.
 */
const byBroadcaster = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const broadcasterId =
      typeof req.params.broadcasterId === 'string' ? req.params.broadcasterId.trim() : '';
    if (!broadcasterId) {
      return next(AppError.badRequest('broadcasterId fehlt.', 'BAD_BROADCASTER'));
    }
    const excludeId =
      typeof req.query.excludeId === 'string' ? req.query.excludeId : undefined;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
    const rows = await clipService.listByBroadcaster(broadcasterId, { excludeId, limit });
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/clips/feed/foryou?limit= — AUTH. Personalisierter „Für dich"-
 * Feed. Algorithmus in `clipService.listPersonalFeed` dokumentiert.
 */
const feedForYou = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 12;
    const rows = await clipService.listPersonalFeed(userId, limit);
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/clips/contributors?limit= — PUBLIC. Top-Einreicher.
 * Liefert pro User: clipCount, avgScore, topClipId, topClipTitle.
 */
const contributors = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 25;
    const rows = await clipService.listTopContributors(limit);
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

export default {
  submit, feedNext, feedForYou, rate, mine, getById, getByShortid,
  report, leaderboard, browse, search, byBroadcaster, contributors
};
