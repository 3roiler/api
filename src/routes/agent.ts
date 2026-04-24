import { Router } from 'express';
import agentController, { agentAuthHandler } from '../controllers/agent.js';

/**
 * All `/api/agent/*` routes authenticate via `X-Agent-Token` (printer-
 * scoped), not the user JWT. Mounted WITHOUT `system.authHandler` in
 * `routes/index.ts` for exactly that reason.
 */
const router = Router();

router.use(agentAuthHandler);

router.post('/heartbeat', agentController.heartbeat);

// Agent sees only what the operator has handed over. No pull-from-queue.
router.get('/jobs/current', agentController.currentJob);
router.post('/jobs/:jobId/transition', agentController.transition);
router.post('/jobs/:jobId/progress', agentController.progress);
router.post('/jobs/:jobId/event', agentController.event);

router.get('/gcode/:id/download', agentController.downloadGcode);

export default router;
