import { Router } from 'express';
import { system } from '../services';
import user from './user.js';

const router = Router();

router.get('/', async (_, res) => {
  res.status(200).send('running');
});

router.get('/health', async (_, res) => {
  const healthState = await system.getHealthState();
  res.status(healthState.ready ? 200 : 503).json(healthState);
});

router.use('/user', user);

export default router;
