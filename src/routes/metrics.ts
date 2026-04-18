import { Router } from 'express';
import { system } from '../services/index.js';
import metricsController from '../controllers/metrics.js';
import requirePermission from '../middleware/requirePermission.js';

/**
 * `/admin/metrics/*` — gated on `dashboard.metrics`. Separate from the
 * umbrella `admin.manage` gate so a future "metrics viewer" role could see
 * utilisation without also getting user CRUD.
 *
 * Layout mirrors the DigitalOcean API:
 *   GET /status                          — which bits of config are set
 *   GET /app                             — app detail (status, deployment…)
 *   GET /app/cpu?window=1h|6h|24h        — CPU time series
 *   GET /app/memory?window=…             — memory time series
 *   GET /database                        — cluster detail
 *   GET /database/cpu?window=…           — cluster CPU
 *   GET /database/memory?window=…        — cluster memory
 *   GET /database/disk?window=…          — cluster disk usage
 */

const router = Router();

const gate = [system.authHandler, requirePermission('dashboard.metrics')];

router.get('/status', ...gate, metricsController.getStatus);

router.get('/app', ...gate, metricsController.getAppSummary);
router.get('/app/cpu', ...gate, metricsController.getAppCpu);
router.get('/app/memory', ...gate, metricsController.getAppMemory);

router.get('/database', ...gate, metricsController.getDatabaseSummary);
router.get('/database/cpu', ...gate, metricsController.getDatabaseCpu);
router.get('/database/memory', ...gate, metricsController.getDatabaseMemory);
router.get('/database/disk', ...gate, metricsController.getDatabaseDisk);

export default router;
