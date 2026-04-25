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
 */
export function requireRawBuffer(req: Request, maxBytes: number, label: string): Buffer {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw AppError.badRequest(
      `Request body must be the raw ${label} bytes (Content-Type: application/octet-stream).`,
      'EMPTY_BODY'
    );
  }
  if (req.body.length > maxBytes) {
    throw AppError.badRequest(
      `${label} überschreitet Limit (${maxBytes} Bytes).`,
      'FILE_TOO_LARGE'
    );
  }
  return req.body;
}

export function requireFilenameHeader(req: Request): string {
  const header = req.header(FILENAME_HEADER);
  if (typeof header !== 'string' || header.length === 0 || header.length > FILENAME_MAX) {
    throw AppError.badRequest(
      `Header \`X-Filename\` (1–${FILENAME_MAX} Zeichen) fehlt.`,
      'MISSING_FILENAME'
    );
  }
  return header;
}
