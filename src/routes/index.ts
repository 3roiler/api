import { Router } from 'express';
import { system } from '../services';
import user from './user.js';
import github from './github.js';

const router = Router();

router.get('/', async (_, res) => {
  res.status(200).send('running');
});

router.get('/health', async (_, res) => {
  const healthState = await system.getHealthState();
  res.status(healthState.ready ? 200 : 503).json(healthState);
});

router.post('/login', system.loginHandler);
router.post('/register', system.registerHandler);
router.post('/logout', system.logoutHandler);

router.use('/github', github);

router.use('/user', system.authHandler, user);

export default router;