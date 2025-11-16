import { Router } from 'express';
import userRoutes from './userRoutes';
import healthRoutes from './healthRoutes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/users', userRoutes);

export default router;
