import { Router } from 'express';
import pool from '../config/database.js';

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check
 *     tags:
 *       - Health
 *     responses:
 *       '200':
 *         description: Service health information.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthStatus'
 */
router.get('/', async (req, res) => {
  const dbHealthy = await checkDatabase();

  const healthStatus = {
    status: dbHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    service: 'api.broiler.dev',
    database: dbHealthy ? 'connected' : 'disconnected',
    uptime: process.uptime()
  };

  const statusCode = dbHealthy ? 200 : 503;
  res.status(statusCode).json(healthStatus);
});

async function checkDatabase(): Promise<boolean> {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (error) {
      console.error('Database health check failed:', error);
      return false;
    }
  }

export default router;