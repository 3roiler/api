import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import crypto from './crypto.js';
import AppError from './error.js';

/**
 * Same key regex the DB check-constraint uses. Mirror here so we can
 * reject bad keys with a nice 400 instead of a PG "check constraint
 * failed" 500.
 */
const KEY_RE = /^[a-z][a-z0-9_.-]{1,118}[a-z0-9]$/;

/**
 * Plain-text (non-secret) setting. Value is any JSON-serialisable shape;
 * callers should type-check on their side since the DB doesn't.
 */
export interface AppSettingRow<T = unknown> {
  key: string;
  value: T;
  description: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/**
 * Public-safe view of an `app_secret` row. `ciphertext` is *never*
 * serialised — the plaintext only leaves the service in the internal
 * `readSecret` helper.
 */
export interface AppSecretMeta {
  key: string;
  preview: string | null;
  description: string | null;
  hasValue: true;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface WriteSettingOptions<T = unknown> {
  value: T;
  description?: string | null;
  updatedBy?: string | null;
}

export interface WriteSecretOptions {
  /** Pass the plaintext; the service encrypts before writing. */
  plaintext: string;
  description?: string | null;
  updatedBy?: string | null;
}

function assertKey(key: string): void {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw AppError.badRequest(
      'Setting keys must be lowercase dotted identifiers (e.g. `digitalocean.app_id`).',
      'BAD_SETTING_KEY'
    );
  }
}

// ─── Settings (plaintext / JSON) ───────────────────────────────────────────

async function listSettings(): Promise<AppSettingRow[]> {
  const result: QueryResult<AppSettingRow> = await persistence.database.query(
    `SELECT
        key,
        value,
        description,
        updated_by AS "updatedBy",
        updated_at AS "updatedAt"
      FROM app_setting
      ORDER BY key ASC`
  );
  return result.rows;
}

async function getSetting<T = unknown>(key: string): Promise<AppSettingRow<T> | null> {
  assertKey(key);
  const result: QueryResult<AppSettingRow<T>> = await persistence.database.query(
    `SELECT
        key,
        value,
        description,
        updated_by AS "updatedBy",
        updated_at AS "updatedAt"
      FROM app_setting
      WHERE key = $1`,
    [key]
  );
  return result.rows[0] ?? null;
}

/**
 * Convenience: just the value (or `fallback`), skipping the metadata.
 * Used by downstream services that don't care who last wrote the row.
 */
async function getSettingValue<T = unknown>(key: string, fallback: T): Promise<T> {
  const row = await getSetting<T>(key);
  if (row === null || row.value === null || row.value === undefined) return fallback;
  return row.value;
}

async function upsertSetting<T = unknown>(key: string, opts: WriteSettingOptions<T>): Promise<AppSettingRow<T>> {
  assertKey(key);
  const result: QueryResult<AppSettingRow<T>> = await persistence.database.query(
    `INSERT INTO app_setting (key, value, description, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, current_timestamp)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       description = COALESCE(EXCLUDED.description, app_setting.description),
       updated_by = EXCLUDED.updated_by,
       updated_at = current_timestamp
     RETURNING
       key,
       value,
       description,
       updated_by AS "updatedBy",
       updated_at AS "updatedAt"`,
    [key, JSON.stringify(opts.value ?? null), opts.description ?? null, opts.updatedBy ?? null]
  );
  return result.rows[0];
}

async function deleteSetting(key: string): Promise<boolean> {
  assertKey(key);
  const result = await persistence.database.query(
    `DELETE FROM app_setting WHERE key = $1`,
    [key]
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── Secrets (AES-GCM encrypted) ──────────────────────────────────────────

/**
 * Return the metadata for every secret, without decrypting anything.
 * The list endpoint and the admin UI rely on this — nobody sees plaintext
 * unless they explicitly call `readSecret(key)`.
 */
async function listSecrets(): Promise<AppSecretMeta[]> {
  const result = await persistence.database.query<{
    key: string;
    preview: string | null;
    description: string | null;
    updatedBy: string | null;
    updatedAt: Date;
  }>(
    `SELECT
        key,
        preview,
        description,
        updated_by AS "updatedBy",
        updated_at AS "updatedAt"
      FROM app_secret
      ORDER BY key ASC`
  );
  return result.rows.map((row) => ({ ...row, hasValue: true as const }));
}

async function getSecretMeta(key: string): Promise<AppSecretMeta | null> {
  assertKey(key);
  const result = await persistence.database.query<{
    key: string;
    preview: string | null;
    description: string | null;
    updatedBy: string | null;
    updatedAt: Date;
  }>(
    `SELECT
        key,
        preview,
        description,
        updated_by AS "updatedBy",
        updated_at AS "updatedAt"
      FROM app_secret
      WHERE key = $1`,
    [key]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, hasValue: true as const };
}

/**
 * Fetch and decrypt a secret by key. Returns `null` when the row doesn't
 * exist so callers can fall back gracefully (e.g. "DO token not configured
 * yet"). Throws `SECRET_DECRYPT_FAILED` when the row exists but can't be
 * decrypted — that's always a bug (bad `SECRETS_KEY`, corrupted bytes)
 * and should not be silently swallowed.
 */
async function readSecret(key: string): Promise<string | null> {
  assertKey(key);
  const result = await persistence.database.query<{
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
  }>(
    `SELECT ciphertext, iv, auth_tag AS "authTag" FROM app_secret WHERE key = $1`,
    [key]
  );
  const row = result.rows[0];
  if (!row) return null;
  return crypto.decrypt({
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag
  });
}

async function writeSecret(key: string, opts: WriteSecretOptions): Promise<AppSecretMeta> {
  assertKey(key);
  if (typeof opts.plaintext !== 'string' || opts.plaintext.length === 0) {
    throw AppError.badRequest('Secret value cannot be empty.', 'BAD_SECRET_VALUE');
  }

  const { ciphertext, iv, authTag } = crypto.encrypt(opts.plaintext);
  const preview = crypto.buildPreview(opts.plaintext);

  const result = await persistence.database.query<{
    key: string;
    preview: string | null;
    description: string | null;
    updatedBy: string | null;
    updatedAt: Date;
  }>(
    `INSERT INTO app_secret (key, ciphertext, iv, auth_tag, preview, description, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, current_timestamp)
     ON CONFLICT (key) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       preview = EXCLUDED.preview,
       description = COALESCE(EXCLUDED.description, app_secret.description),
       updated_by = EXCLUDED.updated_by,
       updated_at = current_timestamp
     RETURNING
       key,
       preview,
       description,
       updated_by AS "updatedBy",
       updated_at AS "updatedAt"`,
    [key, ciphertext, iv, authTag, preview, opts.description ?? null, opts.updatedBy ?? null]
  );
  return { ...result.rows[0], hasValue: true as const };
}

async function deleteSecret(key: string): Promise<boolean> {
  assertKey(key);
  const result = await persistence.database.query(
    `DELETE FROM app_secret WHERE key = $1`,
    [key]
  );
  return (result.rowCount ?? 0) > 0;
}

export default {
  // plain settings
  listSettings,
  getSetting,
  getSettingValue,
  upsertSetting,
  deleteSetting,
  // secrets
  listSecrets,
  getSecretMeta,
  readSecret,
  writeSecret,
  deleteSecret
};
