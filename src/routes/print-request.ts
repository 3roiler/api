import { Router } from 'express';
import { system } from '../services/index.js';
import requirePermission from '../middleware/requirePermission.js';
import printRequestController from '../controllers/print-request.js';

/**
 * `/api/print-request` — gated by `print.request` (which moderators
 * also have). Inside the controllers we then split moderator vs
 * non-moderator behaviour: visibility, who can change status, etc.
 *
 * The moderator-only `PATCH` enforces `print.moderate` in addition
 * to the base gate, but we intentionally check inside the controller
 * (via `userService.getPermissions`) rather than chaining a second
 * middleware here — the controller already needs to branch on
 * moderator status for visibility, and a single source of truth keeps
 * the rules legible.
 */
const router = Router();

router.use(system.authHandler, requirePermission('print.request'));

router.get('/', printRequestController.list);
router.post('/', printRequestController.create);

router.get('/:id', printRequestController.getById);
router.patch('/:id', printRequestController.update);
router.post('/:id/cancel', printRequestController.cancel);

router.post('/:id/comment', printRequestController.addComment);

export default router;
