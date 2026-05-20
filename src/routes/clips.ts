import { Router } from 'express';
import { system } from '../services/index.js';
import requirePermission from '../middleware/requirePermission.js';
import clipController from '../controllers/clip.js';

/**
 * `/api/clips` — Streamclips-Kernrouten.
 *
 * `/leaderboard` liegt bewusst VOR dem Auth-Gate (öffentlich lesbar).
 * Alles danach erfordert Login; Bewerten/Feed brauchen nur eine
 * Session, Einreichen zusätzlich `clips.submit`.
 *
 * Reihenfolge beachten: die statischen Pfade `/feed/next` und `/mine`
 * stehen vor `/:id`, sonst fängt der `:id`-Parameter sie ab.
 */
const router = Router();

router.get('/leaderboard', clipController.leaderboard);
router.get('/browse', clipController.browse);
router.get('/search', clipController.search);

router.use(system.authHandler);

router.get('/feed/next', clipController.feedNext);
router.get('/mine', clipController.mine);

router.post('/', requirePermission('clips.submit'), clipController.submit);

router.get('/:id', clipController.getById);
router.post('/:id/rating', clipController.rate);
router.post('/:id/report', clipController.report);

export default router;
