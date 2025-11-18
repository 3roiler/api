import { Router } from 'express';
import health from './health.js';
import user from './user.js';
import auth from './auth.js';

const router = Router();

router.use('/health', health);
router.use('/users', user);
router.use('/auth', auth);

export default router;
