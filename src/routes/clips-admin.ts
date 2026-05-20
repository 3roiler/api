import { Router } from 'express';
import { system } from '../services/index.js';
import requirePermission from '../middleware/requirePermission.js';
import clipAdminController from '../controllers/clip-admin.js';

/**
 * Streamclips-Moderation, gemountet unter `/api/admin/streamclips`.
 * Komplett `clips.moderate`-only (auth zuerst, damit 401 vor 403 greift).
 */
const router = Router();

router.use(system.authHandler, requirePermission('clips.moderate'));

// Moderations-Queue
router.get('/clips', clipAdminController.moderationQueue);
router.patch('/clips/:id', clipAdminController.setStatus);

// Award-Kategorien
router.get('/awards', clipAdminController.listAwards);
router.post('/awards', clipAdminController.createAward);
router.patch('/awards/:id', clipAdminController.updateAward);
router.delete('/awards/:id', clipAdminController.removeAward);

// Meldungen
router.get('/reports', clipAdminController.listReports);
router.patch('/reports/:id', clipAdminController.resolveReport);

// Twitch-Kategorien → Sektion
router.get('/categories', clipAdminController.listCategories);
router.patch('/categories/:id', clipAdminController.setCategorySection);

// Eingangsprüfung-Einstellungen (Tageslimit, Review-Toggle, Sektionen)
router.get('/moderation-settings', clipAdminController.getModerationSettings);
router.put('/moderation-settings', clipAdminController.updateModerationSettings);

export default router;
