import { Request, Response, NextFunction } from 'express';
import settingsService from '../services/settings.js';
import AppError from '../services/error.js';

/**
 * Admin settings controller. Every route mounted through this file must go
 * through `requirePermission('dashboard.settings')` in the route file — the
 * handlers here trust the gate.
 *
 * Two flat resources:
 *
 *  - `/admin/settings/*` — plain JSON config (readable). Body shape:
 *      `{ value: <any>, description?: string }`
 *
 *  - `/admin/settings/secrets/*` — AES-GCM-encrypted strings. Body shape:
 *      `{ plaintext: string, description?: string }`
 *    Read endpoints never return the plaintext; the UI only sees metadata
 *    + a preview hint.
 *
 * Keys are validated in the service layer (same regex as the DB check
 * constraint) so the controller only worries about the body shape.
 */

const DESCRIPTION_MAX = 500;
const SECRET_MAX = 4096;

function validateDescription(value: unknown, next: NextFunction): value is string | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string' || value.length > DESCRIPTION_MAX) {
    next(AppError.badRequest(`description must be a string ≤ ${DESCRIPTION_MAX} chars.`, 'BAD_DESCRIPTION'));
    return false;
  }
  return true;
}

// ─── Plain settings ────────────────────────────────────────────────────────

const listSettings = async (_req: Request, res: Response) => {
  const rows = await settingsService.listSettings();
  res.status(200).json(rows);
};

const getSetting = async (req: Request<{ key: string }>, res: Response, next: NextFunction) => {
  const row = await settingsService.getSetting(req.params.key);
  if (!row) {
    return next(AppError.notFound('Setting not found.', 'SETTING_NOT_FOUND'));
  }
  return res.status(200).json(row);
};

const upsertSetting = async (req: Request<{ key: string }>, res: Response, next: NextFunction) => {
  const { key } = req.params;
  const body = (req.body ?? {}) as { value?: unknown; description?: unknown };

  if (!('value' in body)) {
    return next(AppError.badRequest('Body must include a `value` field.', 'BAD_SETTING_VALUE'));
  }
  if (!validateDescription(body.description, next)) return;

  const row = await settingsService.upsertSetting(key, {
    value: body.value,
    description: (body.description as string | null | undefined) ?? null,
    updatedBy: req.userId ?? null
  });
  return res.status(200).json(row);
};

const deleteSetting = async (req: Request<{ key: string }>, res: Response, next: NextFunction) => {
  const deleted = await settingsService.deleteSetting(req.params.key);
  if (!deleted) {
    return next(AppError.notFound('Setting not found.', 'SETTING_NOT_FOUND'));
  }
  return res.status(204).send();
};

// ─── Secrets ───────────────────────────────────────────────────────────────

const listSecrets = async (_req: Request, res: Response) => {
  const rows = await settingsService.listSecrets();
  res.status(200).json(rows);
};

const getSecretMeta = async (req: Request<{ key: string }>, res: Response, next: NextFunction) => {
  const row = await settingsService.getSecretMeta(req.params.key);
  if (!row) {
    return next(AppError.notFound('Secret not found.', 'SECRET_NOT_FOUND'));
  }
  return res.status(200).json(row);
};

const writeSecret = async (req: Request<{ key: string }>, res: Response, next: NextFunction) => {
  const { key } = req.params;
  const body = (req.body ?? {}) as { plaintext?: unknown; description?: unknown };

  if (typeof body.plaintext !== 'string' || body.plaintext.length === 0) {
    return next(AppError.badRequest('Body must include a non-empty `plaintext` string.', 'BAD_SECRET_VALUE'));
  }
  if (body.plaintext.length > SECRET_MAX) {
    return next(AppError.badRequest(`Secret must be ≤ ${SECRET_MAX} chars.`, 'BAD_SECRET_VALUE'));
  }
  if (!validateDescription(body.description, next)) return;

  const row = await settingsService.writeSecret(key, {
    plaintext: body.plaintext,
    description: (body.description as string | null | undefined) ?? null,
    updatedBy: req.userId ?? null
  });
  return res.status(200).json(row);
};

const deleteSecret = async (req: Request<{ key: string }>, res: Response, next: NextFunction) => {
  const deleted = await settingsService.deleteSecret(req.params.key);
  if (!deleted) {
    return next(AppError.notFound('Secret not found.', 'SECRET_NOT_FOUND'));
  }
  return res.status(204).send();
};

export default {
  listSettings,
  getSetting,
  upsertSetting,
  deleteSetting,
  listSecrets,
  getSecretMeta,
  writeSecret,
  deleteSecret
};
