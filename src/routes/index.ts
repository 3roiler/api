import { Router } from 'express';
import health from './health.js';
import user from './user.js';
import auth from './auth.js';
import docs from './docs.js';

const router = Router();

router.use('/health', health);
router.use('/users', user);
router.use('/auth', auth);
router.use('/docs', docs);

export default router;
