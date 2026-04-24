import { Router } from 'express';
import printerController from '../controllers/printer.js';
import printJobRoutes from './print-job.js';

const router = Router();

router.get('/', printerController.listMine);
router.post('/', printerController.createPrinter);

router.get('/:id', printerController.getById);
router.put('/:id', printerController.updatePrinter);
router.delete('/:id', printerController.deletePrinter);

router.post('/:id/rotate-token', printerController.rotateAgentToken);

router.get('/:id/access', printerController.listAccess);
router.post('/:id/access', printerController.grantAccess);
router.delete('/:id/access/:userId', printerController.revokeAccess);

// Jobs live under each printer so ACL re-use is automatic; the child
// router reads `:id` via `mergeParams: true` and does its own role
// check so viewers can see queues but only operators can enqueue.
router.use('/:id/jobs', printJobRoutes);

export default router;
