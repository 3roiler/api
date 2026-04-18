import { Router } from 'express';
import { system } from '../services/index.js';
import adminController from '../controllers/admin.js';
import requirePermission from '../middleware/requirePermission.js';

const router = Router();

// Every route here is admin.manage-only. Auth happens first (so 401 beats
// 403 when the session is missing entirely), then the permission gate.
const adminGate = [system.authHandler, requirePermission('admin.manage')];

router.get('/users', ...adminGate, adminController.listUsers);
router.get('/permissions', ...adminGate, adminController.listPermissions);
router.post('/users/:id/permissions', ...adminGate, adminController.grantPermission);
router.delete('/users/:id/permissions/:permission', ...adminGate, adminController.revokePermission);

export default router;
