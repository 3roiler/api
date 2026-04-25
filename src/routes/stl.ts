import { Router, raw } from 'express';
import stlController from '../controllers/stl.js';
import config from '../services/config.js';

/**
 * Mirror of `/api/gcode` — same upload model (raw octet-stream +
 * `X-Filename` header), same size cap. Only the magic-byte check and
 * metadata parser differ, both inside the controller/service.
 */
const router = Router();

const rawStl = raw({
  type: 'application/octet-stream',
  limit: config.gcodeMaxBytes
});

router.get('/', stlController.listMine);
router.post('/', rawStl, stlController.uploadStl);

router.get('/:id', stlController.getById);
router.get('/:id/content', stlController.getContent);
router.delete('/:id', stlController.deleteStl);

export default router;
