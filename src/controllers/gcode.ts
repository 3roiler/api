import { Request, Response, NextFunction } from 'express';
import { gcode as gcodeService } from '../services/index.js';
import config from '../services/config.js';
import AppError from '../services/error.js';
import { requireUser, requireRawBuffer, requireFilenameHeader } from './asset-controller.js';

/**
 * Accepts a raw G-code body (`Content-Type: application/octet-stream`)
 * with the desired filename in `X-Filename`. Multipart was considered
 * and dropped — slicers emit plain .gcode files and the browser can
 * POST the blob directly via `fetch`, no extra dep needed. Size cap is
 * enforced twice: by `express.raw({ limit })` at the route level and
 * again inside the service before the bytea insert.
 */
const uploadGcode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const buffer = requireRawBuffer(req, config.gcodeMaxBytes, 'G-Code');
    const headerName = requireFilenameHeader(req);

    const file = await gcodeService.uploadGcode({
      filename: headerName,
      buffer,
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
    const files = await gcodeService.listForUser(userId, limit, offset);
    return res.status(200).json(files);
  } catch (err) {
    return next(err);
  }
};

const getById = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const file = await gcodeService.getById(id);
    // Uploader-scoped for now; sharing flows land with the printer
    // ACL in Phase 5.
    if (file?.uploadedByUserId !== userId) {
      return next(AppError.notFound('G-code not found', 'GCODE_NOT_FOUND'));
    }
    return res.status(200).json(file);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/gcode/:id/content
 *   Returns the raw G-code body as `text/plain; charset=utf-8`. Used by
 *   the in-browser editor. Owner-scoped — the file is only readable by
 *   its uploader. The agent download lives at `/api/agent/gcode/:id/
 *   download` with separate auth and stricter gating.
 *   Cap is enforced indirectly via the same `gcodeMaxBytes` limit on
 *   upload — anything stored is by definition within bounds.
 */
const getContent = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const meta = await gcodeService.getById(id);
    if (meta?.uploadedByUserId !== userId) {
      return next(AppError.notFound('G-code not found', 'GCODE_NOT_FOUND'));
    }
    const buf = await gcodeService.getContent(id);
    if (!buf) {
      return next(AppError.internal('G-code content missing.', 'GCODE_CONTENT_MISSING'));
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Filename', meta.originalFilename);
    res.setHeader('X-Sha256', meta.sha256);
    return res.status(200).send(buf);
  } catch (err) {
    return next(err);
  }
};

const deleteGcode = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const file = await gcodeService.getById(id);
    if (file?.uploadedByUserId !== userId) {
      return next(AppError.notFound('G-code not found', 'GCODE_NOT_FOUND'));
    }

    try {
      const deleted = await gcodeService.deleteGcode(id);
      if (!deleted) {
        return next(AppError.notFound('G-code not found', 'GCODE_NOT_FOUND'));
      }
    } catch (err) {
      // FK violation from print_job(gcode_file_id) ON DELETE RESTRICT:
      // file is still referenced by a job. Surface a clean 409 rather
      // than letting the 500-path log a Postgres stack trace.
      if (err instanceof Error && 'code' in err && (err as { code?: string }).code === '23503') {
        return next(AppError.conflict(
          'G-Code ist noch mit Druckjobs verknüpft und kann nicht gelöscht werden.',
          'GCODE_IN_USE'
        ));
      }
      throw err;
    }
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

export default {
  uploadGcode,
  listMine,
  getById,
  getContent,
  deleteGcode
};
