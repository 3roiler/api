import { Router } from 'express';
import { system } from '../services/index.js';
import adminController from '../controllers/admin.js';
import requirePermission from '../middleware/requirePermission.js';

const router = Router();

// Every route here is admin.manage-only. Auth happens first (so 401 beats
// 403 when the session is missing entirely), then the permission gate.
const adminGate = [system.authHandler, requirePermission('admin.manage')];

// ─── Permissions catalog ────────────────────────────────────────────────
router.get('/permissions', ...adminGate, adminController.listPermissions);

// ─── Users ──────────────────────────────────────────────────────────────
router.get('/users', ...adminGate, adminController.listUsers);
router.put('/users/:id', ...adminGate, adminController.updateUser);
router.delete('/users/:id', ...adminGate, adminController.deleteUser);
router.post('/users/:id/permissions', ...adminGate, adminController.grantUserPermission);
router.delete('/users/:id/permissions/:permission', ...adminGate, adminController.revokeUserPermission);

// ─── Groups ─────────────────────────────────────────────────────────────
router.get('/groups', ...adminGate, adminController.listGroups);
router.post('/groups', ...adminGate, adminController.createGroup);
router.get('/groups/:id', ...adminGate, adminController.getGroup);
router.put('/groups/:id', ...adminGate, adminController.updateGroup);
router.delete('/groups/:id', ...adminGate, adminController.deleteGroup);

// Group membership
router.post('/groups/:id/members', ...adminGate, adminController.addGroupMember);
router.delete('/groups/:id/members/:userId', ...adminGate, adminController.removeGroupMember);

// Group permissions
router.post('/groups/:id/permissions', ...adminGate, adminController.grantGroupPermission);
router.delete('/groups/:id/permissions/:permission', ...adminGate, adminController.revokeGroupPermission);

export default router;
