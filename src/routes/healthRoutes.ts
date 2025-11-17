import { Router } from 'express';
import userService from '../services/userService.js';

const router = Router();

/**
 * @route   GET /health
 * @desc    Health check endpoint
 * @access  Public
 */
router.get('/', async (req, res) => {
  const dbHealthy = await userService.healthCheck();
  
  const healthStatus = {
    status: dbHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    service: 'api.broiler.dev',
    database: dbHealthy ? 'connected' : 'disconnected',
    uptime: process.uptime(),
  };

  const statusCode = dbHealthy ? 200 : 503;
  res.status(statusCode).json(healthStatus);
});

export default router;
