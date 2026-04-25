import { Router, raw } from 'express';
import gcodeController from '../controllers/gcode.js';
import config from '../services/config.js';

const router = Router();

/**
 * `express.raw` short-circuits JSON parsing for this one route — the
 * body arrives as a `Buffer` straight into the controller. `type` is
 * bound to `application/octet-stream` so the global `express.json()`
 * still handles JSON on every other endpoint without conflicts.
 * `limit` mirrors `GCODE_MAX_BYTES`; the service re-checks post-parse.
 */
const rawGcode = raw({
  type: 'application/octet-stream',
  limit: config.gcodeMaxBytes
});

router.get('/', gcodeController.listMine);
router.post('/', rawGcode, gcodeController.uploadGcode);

router.get('/:id', gcodeController.getById);
router.get('/:id/content', gcodeController.getContent);
router.delete('/:id', gcodeController.deleteGcode);

export default router;
