import type { Request } from 'express';
import AppError from '../services/error.js';

/**
 * Shared request-validation helpers for the asset upload endpoints
 * (`gcode`, `stl`, future slicer outputs).
 *
 * The G-code and STL controllers used to repeat the same three checks
 * — auth, body-is-buffer, X-Filename header — verbatim. Extracted here
 * so the per-asset controller stays focused on the actual
 * format-specific validation and the service call.
 *
 * Each helper throws `AppError` directly; the calling controller's
 * `try/catch` forwards it to `next(err)` as before.
 */

const FILENAME_HEADER = 'x-filename';
const FILENAME_MAX = 255;

export function requireUser(req: Request): string {
  if (!req.userId) {
    throw AppError.unauthorized('No authenticated user.');
  }
  return req.userId;
}

/**
 * Validates the raw body of an `application/octet-stream` upload. The
 * `label` is the German noun used in the size-limit error so messages
 * read naturally ("STL überschreitet Limit").
 *
 * Reads `req.body` once into a local before checking. Express types
 * the property as `any`; CodeQL flags the multi-read pattern as
 * potential type-confusion (a tampered request could in principle
 * yield a different shape between reads, e.g. an array on the type
 * check and something else on the size read). Pinning to a local
 * makes the check + use atomic.
 */
export function requireRawBuffer(req: Request, maxBytes: number, label: string): Buffer {
  // Two-step narrowing keeps CodeQL happy: the `||` form was still
  // flagged because the analyser couldn't follow the type-guard
  // through the alternation. Splitting the type-check from the
  // length-check, then re-binding into a typed `const buffer`, makes
  // each branch unambiguously about a verified Buffer.
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body)) {
    throw AppError.badRequest(
      `Request body must be the raw ${label} bytes (Content-Type: application/octet-stream).`,
      'EMPTY_BODY'
    );
  }
  const buffer: Buffer = body;
  if (buffer.length === 0) {
    throw AppError.badRequest(
      `Request body must be the raw ${label} bytes (Content-Type: application/octet-stream).`,
      'EMPTY_BODY'
    );
  }
  if (buffer.length > maxBytes) {
    throw AppError.badRequest(
      `${label} überschreitet Limit (${maxBytes} Bytes).`,
      'FILE_TOO_LARGE'
    );
  }
  return buffer;
}

export function requireFilenameHeader(req: Request): string {
  // Two-step narrowing matching `requireRawBuffer`: Express's
  // `req.header()` is typed `string | string[] | undefined`, so the
  // `typeof !== 'string'` guard runs first on its own, then the
  // length checks live on a re-bound typed local. Splitting the
  // checks keeps CodeQL's type-confusion analysis from tripping over
  // the alternation.
  const raw: unknown = req.header(FILENAME_HEADER);
  if (typeof raw !== 'string') {
    throw AppError.badRequest(
      `Header \`X-Filename\` (1–${FILENAME_MAX} Zeichen) fehlt.`,
      'MISSING_FILENAME'
    );
  }
  const header: string = raw;
  if (header.length === 0 || header.length > FILENAME_MAX) {
    throw AppError.badRequest(
      `Header \`X-Filename\` (1–${FILENAME_MAX} Zeichen) fehlt.`,
      'MISSING_FILENAME'
    );
  }
  return header;
}
