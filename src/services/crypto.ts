import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import config from './config.js';
import AppError from './error.js';

/**
 * AES-256-GCM envelope encryption for `app_secret` rows.
 *
 * Design choices worth calling out:
 *
 * - **Key from env, not the DB.** The key itself lives in `SECRETS_KEY`
 *   (base64, 32 bytes) as an encrypted DigitalOcean env var. Keeping it
 *   out of the database means a DB dump alone can't decrypt anything.
 *
 * - **Fresh 12-byte IV per encryption.** GCM IVs must never repeat for a
 *   given key; `randomBytes(12)` gives us 96 bits, which is the standard
 *   and well above birthday-bound concerns at our volume.
 *
 * - **Tag stored separately, not appended.** Keeping `ciphertext`, `iv`
 *   and `auth_tag` as three columns is less clever than concatenating
 *   them, but makes bytea dumps easy to inspect and future key rotation
 *   (re-encrypt + `UPDATE`) a one-row change per secret.
 *
 * - **No IV reuse for updates.** `encrypt` always generates a new IV,
 *   so even writing the same value twice gives different ciphertext.
 *
 * - **Fail loud on missing key.** If `SECRETS_KEY` is empty, we throw
 *   on first use rather than letting the app boot and then corrupt
 *   `app_secret` rows with zeroed keys.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = config.secretsKey;
  if (!raw) {
    throw AppError.internal(
      '`SECRETS_KEY` is not set. Generate one with `openssl rand -base64 32` and set it as an encrypted env var before reading or writing secrets.',
      'SECRETS_KEY_MISSING'
    );
  }

  // Accept either base64 or raw hex so the env var can be pasted from
  // either `openssl rand -base64 32` or `openssl rand -hex 32`. We only
  // commit to 32-byte output — anything else is almost certainly a
  // truncation or typo we want to catch immediately.
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
    if (buf.length !== KEY_BYTES) {
      buf = Buffer.from(raw, 'hex');
    }
  } catch {
    throw AppError.internal('`SECRETS_KEY` could not be decoded as base64 or hex.', 'SECRETS_KEY_INVALID');
  }

  if (buf.length !== KEY_BYTES) {
    throw AppError.internal(
      `\`SECRETS_KEY\` must decode to ${KEY_BYTES} bytes (got ${buf.length}). Regenerate with \`openssl rand -base64 32\`.`,
      'SECRETS_KEY_INVALID'
    );
  }

  cachedKey = buf;
  return buf;
}

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function encrypt(plaintext: string): EncryptedPayload {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

export function decrypt({ ciphertext, iv, authTag }: EncryptedPayload): string {
  if (iv.length !== IV_BYTES) {
    throw AppError.internal(`IV length mismatch: expected ${IV_BYTES}, got ${iv.length}.`, 'SECRET_IV_INVALID');
  }
  if (authTag.length !== TAG_BYTES) {
    throw AppError.internal(`auth_tag length mismatch: expected ${TAG_BYTES}, got ${authTag.length}.`, 'SECRET_TAG_INVALID');
  }
  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Most often this means SECRETS_KEY was rotated without re-encrypting
    // stored rows — surface as a clear 500 rather than a cryptic
    // "unsupported state" from OpenSSL.
    throw AppError.internal('Failed to decrypt secret. The encryption key may have changed.', 'SECRET_DECRYPT_FAILED');
  }
}

/**
 * Build a non-sensitive preview hint for display in the admin UI. We show
 * the length and the last few characters only (tokens are usually
 * distinguishable by their suffix). Returns `null` for empty strings so
 * the caller can fall back to a placeholder.
 */
export function buildPreview(plaintext: string): string | null {
  if (plaintext.length === 0) return null;
  if (plaintext.length <= 4) {
    // Very short values (PINs etc) — don't reveal anything meaningful.
    return `${plaintext.length} chars`;
  }
  const tail = plaintext.slice(-4);
  return `${plaintext.length} chars · …${tail}`;
}

/**
 * Exposed only for the health check / boot log so ops can tell whether
 * secrets are going to work before the first request.
 */
export function isConfigured(): boolean {
  return config.secretsKey.length > 0;
}

export default {
  encrypt,
  decrypt,
  buildPreview,
  isConfigured
};
