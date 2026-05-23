import { Router } from 'express';
import { system } from '../services/index.js';
import requirePermission from '../middleware/requirePermission.js';
import clipAdminController from '../controllers/clip-admin.js';
import commentController from '../controllers/comment.js';

/**
 * Streamclips-Moderation, gemountet unter `/api/admin/streamclips`.
 * Komplett `clips.moderate`-only (auth zuerst, damit 401 vor 403 greift).
 */
const router = Router();

router.use(system.authHandler, requirePermission('clips.moderate'));

// Moderations-Queue
router.get('/clips', clipAdminController.moderationQueue);
// Bulk-Moderation. Muss VOR `/clips/:id` registriert sein, sonst fängt
// die :id-Route den Pfad ab und versucht „bulk-moderate" als UUID zu
// parsen.
router.post('/clips/bulk-moderate', clipAdminController.bulkModerate);
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

// „Für dich"-Algorithmus (Gewichte + Schwellen)
router.get('/foryou-settings', clipAdminController.getForYouSettings);
router.put('/foryou-settings', clipAdminController.updateForYouSettings);

// Kommentar-Mute (User vom Kommentieren ausschließen, mit Begründung und
// optionalem Ablaufdatum). Permissions werden vom Controller geprüft —
// das Sub-Router-Gate `clips.moderate` greift bereits am Mount oben.
router.get('/mutes', commentController.listMutes);
router.post('/users/:id/mute', commentController.muteUser);
router.delete('/users/:id/mute', commentController.unmuteUser);

export default router;
