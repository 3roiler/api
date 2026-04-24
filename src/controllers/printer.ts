import { Request, Response, NextFunction } from 'express';
import { printer as printerService } from '../services/index.js';
import AppError from '../services/error.js';
import type { PrinterRole } from '../models/index.js';

const NAME_MAX = 60;
const MODEL_MAX = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES: PrinterRole[] = ['operator', 'contributor', 'viewer'];

function requireUser(req: Request): string {
  if (!req.userId) {
    throw AppError.unauthorized('No authenticated user.');
  }
  return req.userId;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(`\`${field}\` must be a UUID.`, 'BAD_UUID');
  }
  return value;
}

const listMine = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const printers = await printerService.listPrintersForUser(userId);
    return res.status(200).json(printers);
  } catch (err) {
    return next(err);
  }
};

const getById = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const found = await printerService.getPrinterForUser(id, userId);
    if (!found) {
      return next(AppError.notFound('Printer not found', 'PRINTER_NOT_FOUND'));
    }
    return res.status(200).json(found);
  } catch (err) {
    return next(err);
  }
};

/**
 * Creates a printer and assigns the caller as owner. The response
 * includes the one-shot `agentToken` — frontend must surface it to
 * the user (they paste it into the agent config) and warn that it
 * won't be shown again.
 */
const createPrinter = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { name, model } = (req.body ?? {}) as { name?: unknown; model?: unknown };

    if (typeof name !== 'string' || name.trim().length === 0 || name.length > NAME_MAX) {
      return next(AppError.badRequest(`name muss 1–${NAME_MAX} Zeichen lang sein.`, 'BAD_NAME'));
    }
    if (typeof model !== 'string' || model.trim().length === 0 || model.length > MODEL_MAX) {
      return next(AppError.badRequest(`model muss 1–${MODEL_MAX} Zeichen lang sein.`, 'BAD_MODEL'));
    }

    const result = await printerService.createPrinter({
      name: name.trim(),
      model: model.trim(),
      ownerUserId: userId
    });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
};

const updatePrinter = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    await printerService.assertRole(userId, id, 'owner');

    const { name } = (req.body ?? {}) as { name?: unknown };
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0 || name.length > NAME_MAX)) {
      return next(AppError.badRequest(`name muss 1–${NAME_MAX} Zeichen lang sein.`, 'BAD_NAME'));
    }

    const updated = await printerService.updatePrinter(id, {
      name: typeof name === 'string' ? name.trim() : undefined
    });
    if (!updated) {
      return next(AppError.notFound('Printer not found', 'PRINTER_NOT_FOUND'));
    }
    return res.status(200).json(updated);
  } catch (err) {
    return next(err);
  }
};

const deletePrinter = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    await printerService.assertRole(userId, id, 'owner');

    const deleted = await printerService.deletePrinter(id);
    if (!deleted) {
      return next(AppError.notFound('Printer not found', 'PRINTER_NOT_FOUND'));
    }
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

/**
 * Replaces the agent token. Returns the new plaintext — client must
 * paste it into the agent's config. Any active agent session keeps
 * running until the agent reconnects, where it will be rejected.
 * (Full-force disconnect lands with the agent service in Phase 2.)
 */
const rotateAgentToken = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    await printerService.assertRole(userId, id, 'owner');

    const agentToken = await printerService.rotateAgentToken(id);
    return res.status(200).json({ agentToken });
  } catch (err) {
    return next(err);
  }
};

const listAccess = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    await printerService.assertRole(userId, id, 'owner');
    const rows = await printerService.listAccess(id);
    return res.status(200).json(rows);
  } catch (err) {
    return next(err);
  }
};

const grantAccess = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const grantedBy = requireUser(req);
    const { id: printerId } = req.params;
    await printerService.assertRole(grantedBy, printerId, 'owner');

    const body = (req.body ?? {}) as {
      userId?: unknown;
      role?: unknown;
      canViewCamera?: unknown;
      canViewQueue?: unknown;
    };

    const targetUserId = assertUuid(body.userId, 'userId');
    if (typeof body.role !== 'string' || !VALID_ROLES.includes(body.role as PrinterRole)) {
      return next(AppError.badRequest(
        `role muss einer von: ${VALID_ROLES.join(', ')} sein.`,
        'BAD_ROLE'
      ));
    }
    if (body.canViewCamera !== undefined && typeof body.canViewCamera !== 'boolean') {
      return next(AppError.badRequest('canViewCamera muss boolean sein.', 'BAD_CAMERA_FLAG'));
    }
    if (body.canViewQueue !== undefined && typeof body.canViewQueue !== 'boolean') {
      return next(AppError.badRequest('canViewQueue muss boolean sein.', 'BAD_QUEUE_FLAG'));
    }

    const access = await printerService.grantAccess({
      printerId,
      userId: targetUserId,
      role: body.role as PrinterRole,
      canViewCamera: body.canViewCamera === true,
      // Falls nicht angegeben: Service nutzt Default je nach Rolle
      // (true für operator, sonst false).
      canViewQueue: body.canViewQueue === undefined ? undefined : body.canViewQueue,
      grantedBy
    });
    return res.status(200).json(access);
  } catch (err) {
    return next(err);
  }
};

const revokeAccess = async (req: Request<{ id: string; userId: string }>, res: Response, next: NextFunction) => {
  try {
    const callerId = requireUser(req);
    const { id: printerId, userId: targetUserId } = req.params;
    await printerService.assertRole(callerId, printerId, 'owner');

    const removed = await printerService.revokeAccess(printerId, targetUserId);
    if (!removed) {
      return next(AppError.notFound('Access entry not found', 'ACCESS_NOT_FOUND'));
    }
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

export default {
  listMine,
  getById,
  createPrinter,
  updatePrinter,
  deletePrinter,
  rotateAgentToken,
  listAccess,
  grantAccess,
  revokeAccess
};
