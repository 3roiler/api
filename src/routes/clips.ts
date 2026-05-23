import { Router } from 'express';
import { system } from '../services/index.js';
import requirePermission from '../middleware/requirePermission.js';
import clipController from '../controllers/clip.js';

/**
 * `/api/clips` — Streamclips-Kernrouten. Auth ist hier pro Route gesetzt
 * (kein globales Gate), damit das öffentliche Clip-Detail nach den
 * auth-pflichtigen statischen Pfaden stehen kann.
 *
 * Öffentlich (kein Login): leaderboard, browse, search, GET /:id.
 * Auth-pflichtig: feed/next, mine, einreichen (+`clips.submit`), bewerten,
 * melden.
 *
 * Reihenfolge beachten: die statischen GET-Pfade (`/leaderboard`,
 * `/browse`, `/search`, `/feed/next`, `/mine`) stehen vor `/:id`, sonst
 * fängt der `:id`-Parameter sie ab.
 */
const router = Router();

// ── Öffentlich ──
router.get('/leaderboard', clipController.leaderboard);
router.get('/browse', clipController.browse);
router.get('/search', clipController.search);
// „Mehr von diesem Streamer"-Karussell auf der Clip-Detailseite. Pfad-Param
// `broadcasterId` ist eine numerische Twitch-User-ID, kein UUID.
router.get('/by-broadcaster/:broadcasterId', clipController.byBroadcaster);

// ── Auth-pflichtig (statische Pfade VOR dem öffentlichen /:id) ──
router.get('/feed/next', system.authHandler, clipController.feedNext);
router.get('/feed/foryou', system.authHandler, clipController.feedForYou);
router.get('/mine', system.authHandler, clipController.mine);
router.post('/', system.authHandler, requirePermission('clips.submit'), clipController.submit);
router.post('/:id/rating', system.authHandler, clipController.rate);
router.post('/:id/report', system.authHandler, clipController.report);

// Clip-Detail ist öffentlich; der optionale Auth füllt `myRating`, wenn
// der Aufrufer eingeloggt ist.
router.get('/:id', system.optionalAuthHandler, clipController.getById);

export default router;
