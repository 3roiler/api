import { Request, Response, NextFunction } from 'express';
import { stl as stlService } from '../services/index.js';
import config from '../services/config.js';
import AppError from '../services/error.js';

const FILENAME_HEADER = 'x-filename';
const FILENAME_MAX = 255;

function requireUser(req: Request): string {
  if (!req.userId) {
    throw AppError.unauthorized('No authenticated user.');
  }
  return req.userId;
}

/**
 * POST /api/stl
 *   Body: raw STL bytes, `Content-Type: application/octet-stream`
 *   Header: `X-Filename` for the original filename.
 *
 * Same upload shape as `/api/gcode` so the frontend can reuse its
 * raw-octet-stream upload helper. Size cap reuses `gcodeMaxBytes`
 * (50 MB default) — STLs are usually smaller than the resulting
 * G-code anyway, so a separate `stlMaxBytes` would just be config
 * sprawl until we have evidence it's needed.
 */
const uploadStl = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return next(AppError.badRequest(
        'Request body must be the raw STL bytes (Content-Type: application/octet-stream).',
        'EMPTY_BODY'
      ));
    }
    if (req.body.length > config.gcodeMaxBytes) {
      return next(AppError.badRequest(
        `STL überschreitet Limit (${config.gcodeMaxBytes} Bytes).`,
        'FILE_TOO_LARGE'
      ));
    }

    const headerName = req.header(FILENAME_HEADER);
    if (!headerName || typeof headerName !== 'string' || headerName.length === 0 || headerName.length > FILENAME_MAX) {
      return next(AppError.badRequest(
        `Header \`X-Filename\` (1–${FILENAME_MAX} Zeichen) fehlt.`,
        'MISSING_FILENAME'
      ));
    }

    const file = await stlService.uploadStl({
      filename: headerName,
      buffer: req.body,
      uploadedByUserId: userId
    });
    return res.status(201).json(file);
  } catch (err) {
    return next(err);
  }
};

const listMine = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
    const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const files = await stlService.listForUser(userId, limit, offset);
    return res.status(200).json(files);
  } catch (err) {
    return next(err);
  }
};

const getById = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const file = await stlService.getById(id);
    if (!file || file.uploadedByUserId !== userId) {
      return next(AppError.notFound('STL not found', 'STL_NOT_FOUND'));
    }
    return res.status(200).json(file);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/stl/:id/content
 *   Streams the raw STL bytes back as `application/octet-stream`.
 *   The frontend pipes this straight into three.js' STLLoader for
 *   the viewer. Owner-scoped — the file is only readable by its
 *   uploader.
 */
const getContent = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const meta = await stlService.getById(id);
    if (!meta || meta.uploadedByUserId !== userId) {
      return next(AppError.notFound('STL not found', 'STL_NOT_FOUND'));
    }
    const buf = await stlService.getContent(id);
    if (!buf) {
      return next(AppError.internal('STL content missing.', 'STL_CONTENT_MISSING'));
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', meta.sizeBytes.toString());
    res.setHeader('X-Filename', meta.originalFilename);
    res.setHeader('X-Sha256', meta.sha256);
    return res.status(200).send(buf);
  } catch (err) {
    return next(err);
  }
};

const deleteStl = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const file = await stlService.getById(id);
    if (!file || file.uploadedByUserId !== userId) {
      return next(AppError.notFound('STL not found', 'STL_NOT_FOUND'));
    }
    const deleted = await stlService.deleteStl(id);
    if (!deleted) {
      return next(AppError.notFound('STL not found', 'STL_NOT_FOUND'));
    }
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

export default {
  uploadStl,
  listMine,
  getById,
  getContent,
  deleteStl
};
