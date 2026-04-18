import { Router } from 'express';
import { system } from '../services/index.js';
import settingsController from '../controllers/settings.js';
import requirePermission from '../middleware/requirePermission.js';

/**
 * `/admin/settings/*` — gated on `dashboard.settings` rather than
 * `admin.manage`, so in the future a non-admin could be given read/write
 * access to site config without inheriting user CRUD. The bootstrap hook
 * grants `dashboard.settings` automatically to anyone with `admin.manage`,
 * so this doesn't change anything for existing admins.
 *
 * Layout:
 *   GET    /                 — list all plain-text settings
 *   GET    /secrets          — list secret metadata (never plaintext)
 *   PUT    /secrets/:key     — write/rotate a secret (encrypts server-side)
 *   DELETE /secrets/:key     — delete a secret
 *   GET    /:key             — read one plain setting
 *   PUT    /:key             — upsert a plain setting
 *   DELETE /:key             — delete a plain setting
 *
 * `/secrets` routes are declared first so the `/:key` catch-all doesn't
 * shadow them.
 */

const router = Router();

const gate = [system.authHandler, requirePermission('dashboard.settings')];

// Plain settings list.
router.get('/', ...gate, settingsController.listSettings);

// Secrets — metadata only on read, encrypted on write.
router.get('/secrets', ...gate, settingsController.listSecrets);
router.get('/secrets/:key', ...gate, settingsController.getSecretMeta);
router.put('/secrets/:key', ...gate, settingsController.writeSecret);
router.delete('/secrets/:key', ...gate, settingsController.deleteSecret);

// Plain settings — per-key CRUD.
router.get('/:key', ...gate, settingsController.getSetting);
router.put('/:key', ...gate, settingsController.upsertSetting);
router.delete('/:key', ...gate, settingsController.deleteSetting);

export default router;
