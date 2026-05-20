import { Router } from 'express';
import categoryController from '../controllers/category.js';

/**
 * `/api/categories` — öffentliche Filter-Stammdaten für die Vote-/
 * Leaderboard-UI. Kein Login nötig.
 */
const router = Router();

router.get('/awards', categoryController.listAwards);
router.get('/sections', categoryController.listSections);

export default router;
