import { Router } from 'express';
import { system } from '../services';
import { csrfTokenHandler } from '../middleware/csrf.js';
import ogController from '../controllers/og.js';
import sitemapController from '../controllers/sitemap.js';
import user from './user.js';
import github from './github.js';
import twitch from './twitch.js';
import blog from './blog.js';
import admin from './admin.js';
import printer from './printer.js';
import gcode from './gcode.js';
import stl from './stl.js';
import printRequest from './print-request.js';
import agent from './agent.js';
import clips from './clips.js';
import categories from './categories.js';

const router = Router();

router.get('/', async (_, res) => {
  res.status(200).send('running');
});

router.get(
  '/health',
  (_, res, next) => {
    res.locals.skipLogging = true;
    next();
  },
  async (_, res) => {
    const healthState = await system.getHealthState();
    res.status(healthState.ready ? 200 : 503).json(healthState);
  }
);

// CSRF: das SPA holt hier sein Token (Body) und echo't es per X-CSRF-Token.
// Öffentlich + ohne Seiteneffekt; das Token-Cookie setzt der globale Guard.
router.get('/csrf', csrfTokenHandler);

// Dynamische sitemap.xml (Caddy proxyt /sitemap.xml hierher). Öffentlich.
router.get('/sitemap.xml', sitemapController.sitemap);

// Open-Graph für Social-Crawler (Caddy leitet nur Crawler-UAs hierher um).
// Öffentlich + nur lesend; rendert serverseitig Meta-Tags für teilbare Seiten.
router.get('/og/streamclips/clip/:id', ogController.clip);
router.get('/og/blog/:slug', ogController.post);

router.post('/login', system.loginHandler);
router.post('/register', system.registerHandler);
router.post('/logout', system.logoutHandler);

router.use('/github', github);
router.use('/twitch', twitch);
router.use('/blog', blog);
router.use('/admin', admin);

// Streamclips Germany. `/clips` gated intern (Leaderboard public, Rest
// auth + clips.submit fürs Einreichen). `/categories` ist öffentlich.
// Die Moderations-Routen hängen unter `/admin/streamclips` (siehe admin.ts).
router.use('/clips', clips);
router.use('/categories', categories);

router.use('/user', system.authHandler, user);
router.use('/printer', system.authHandler, printer);
router.use('/gcode', system.authHandler, gcode);
router.use('/stl', system.authHandler, stl);
// Print-Request gates inside the router itself (auth + print.request).
router.use('/print-request', printRequest);

// Agent routes authenticate via `X-Agent-Token` inside the router — not
// via the user JWT middleware. Mount path is intentionally short because
// the embedded agent on the printer hard-codes it.
router.use('/agent', agent);

export default router;