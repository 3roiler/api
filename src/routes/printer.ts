import { Router } from 'express';
import printerController from '../controllers/printer.js';

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

export default router;
