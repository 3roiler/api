import { Router } from 'express';
import printJobController from '../controllers/print-job.js';

const router = Router({ mergeParams: true });

// Queue + request list (visibility decided in controller)
router.get('/', printJobController.listJobs);

// Current live job on the printer — single-job lookup, visible to anyone
// with access because it's the public-ish fact about the printer.
router.get('/current', printJobController.getCurrent);

// Contributor+ submits a new request. Admin/operator approves/rejects
// later. Not a `queued` job until approveJob runs.
router.post('/', printJobController.createRequest);

router.get('/:jobId', printJobController.getJob);
router.post('/:jobId/approve', printJobController.approveJob);
router.post('/:jobId/reject', printJobController.rejectJob);
router.post('/:jobId/start', printJobController.startJob);
router.patch('/:jobId/priority', printJobController.updatePriority);
router.post('/:jobId/cancel', printJobController.cancelJob);

// Swap the g-code attached to a still-pending job. Used by the editor
// flow: edit → save-as → new file → update pointer.
router.put('/:jobId/gcode', printJobController.replaceGcode);

export default router;
