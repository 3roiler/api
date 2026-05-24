import { Router } from 'express';
import userController from '../controllers/user.js';
import requirePermission from '../middleware/requirePermission.js';

const router = Router();

// Self-service: jede:r authentifizierte Nutzer:in über sich selbst. Diese
// Routen lesen `req.userId` aus dem JWT und ignorieren jegliche IDs aus
// dem Pfad — kein IDOR-Risiko.
//
// `searchUsers` ist absichtlich offen für alle Eingeloggten (Share-Flows
// wie Printer-Access, Team-Invites). Liefert nur ein Minimalprofil.
router.get('/search', userController.searchUsers);
router.get('/me', userController.getMe);
router.put('/me', userController.updateMe);
router.get('/me/export', userController.exportMyData);
router.post('/nuke', userController.nukeMePlease);

// Admin-only: User-Liste mit E-Mails, Anlegen/Bearbeiten/Löschen fremder
// User. Bis zur eigentlichen Migration auf `/admin/users` (siehe
// routes/admin.ts) bleiben diese Pfade bestehen, aber gated.
const adminGate = requirePermission('admin.manage');

router.get('/', adminGate, userController.getAllUsers);
router.post('/', adminGate, userController.createUser);
router.get('/:id', adminGate, userController.getUserById);
router.put('/:id', adminGate, userController.updateUser);
router.delete('/:id', adminGate, userController.deleteUser);

export default router;
