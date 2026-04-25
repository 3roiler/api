import { Router } from 'express';
import { system } from '../services';
import user from './user.js';
import github from './github.js';
import twitch from './twitch.js';
import blog from './blog.js';
import admin from './admin.js';
import printer from './printer.js';
import gcode from './gcode.js';
import stl from './stl.js';
import agent from './agent.js';

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

router.post('/login', system.loginHandler);
router.post('/register', system.registerHandler);
router.post('/logout', system.logoutHandler);

router.use('/github', github);
router.use('/twitch', twitch);
router.use('/blog', blog);
router.use('/admin', admin);

router.use('/user', system.authHandler, user);
router.use('/printer', system.authHandler, printer);
router.use('/gcode', system.authHandler, gcode);
router.use('/stl', system.authHandler, stl);

// Agent routes authenticate via `X-Agent-Token` inside the router — not
// via the user JWT middleware. Mount path is intentionally short because
// the embedded agent on the printer hard-codes it.
router.use('/agent', agent);

export default router;