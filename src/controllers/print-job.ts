import { Request, Response, NextFunction } from 'express';
import { printer as printerService, printJob as printJobService } from '../services/index.js';
import AppError from '../services/error.js';
import type { PrintJobState } from '../models/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATE_FILTERS: PrintJobState[] = [
  'requested', 'queued', 'transferring', 'printing', 'paused', 'completed', 'failed', 'cancelled'
];
const REJECTION_REASON_MAX = 500;

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

function parseStateFilter(raw: unknown): PrintJobState[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const tokens = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = tokens.filter((t) => !VALID_STATE_FILTERS.includes(t as PrintJobState));
  if (invalid.length > 0) {
    throw AppError.badRequest(
      `Unbekannter state-Filter: ${invalid.join(', ')}.`,
      'BAD_STATE_FILTER'
    );
  }
  return tokens as PrintJobState[];
}

/**
 * GET /api/printer/:id/jobs
 *   Visibility rules (enforced here, re-used by getJob):
 *     - owner/operator: all jobs on this printer
 *     - contributor/viewer WITH canViewQueue: all jobs
 *     - contributor/viewer WITHOUT canViewQueue: only their own jobs
 */
const listJobs = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id: printerId } = req.params;
    const access = await printerService.getAccess(userId, printerId);

    const stateFilter = parseStateFilter(req.query.state);
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
    const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

    const canSeeAll = access.role === 'owner' || access.role === 'operator' || access.canViewQueue;

    const jobs = await printJobService.listForPrinter(printerId, {
      state: stateFilter,
      userId: canSeeAll ? undefined : userId,
      limit,
      offset
    });
    return res.status(200).json(jobs);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/printer/:id/jobs/current — what the printer is actually
 * working on right now (transferring/printing/paused) or null. Any user
 * with access can see this, because it's the *public-ish* thing about
 * the printer.
 */
const getCurrent = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id: printerId } = req.params;
    await printerService.getAccess(userId, printerId);

    const job = await printJobService.getCurrentForPrinter(printerId);
    if (!job) return res.status(204).send();
    return res.status(200).json(job);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/printer/:id/jobs — anyone with contributor+ role can file
 * a request. It always starts in `requested` state; the owner/operator
 * decides whether to approve. Priority is *not* accepted here — it's
 * set on approval.
 */
const createRequest = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id: printerId } = req.params;
    await printerService.assertRole(userId, printerId, 'contributor');

    const body = (req.body ?? {}) as { gcodeFileId?: unknown };
    const gcodeFileId = assertUuid(body.gcodeFileId, 'gcodeFileId');

    const job = await printJobService.createRequest({
      printerId,
      userId,
      gcodeFileId
    });
    return res.status(201).json(job);
  } catch (err) {
    return next(err);
  }
};

const getJob = async (req: Request<{ id: string; jobId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id: printerId, jobId } = req.params;
    const access = await printerService.getAccess(userId, printerId);

    const job = await printJobService.getById(jobId);
    if (!job || job.printerId !== printerId) {
      return next(AppError.notFound('Job not found', 'JOB_NOT_FOUND'));
    }

    // Contributors/viewers without canViewQueue only see their own jobs.
    const canSeeAll = access.role === 'owner' || access.role === 'operator' || access.canViewQueue;
    if (!canSeeAll && job.userId !== userId) {
      return next(AppError.notFound('Job not found', 'JOB_NOT_FOUND'));
    }

    const events = await printJobService.listEvents(jobId, 100);
    return res.status(200).json({ ...job, events });
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/printer/:id/jobs/:jobId/approve — owner/operator accepts
 * the request. Optional `priority` parameter sets the initial queue
 * priority (defaults to 0).
 */
const approveJob = async (req: Request<{ id: string; jobId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id: printerId, jobId } = req.params;
    await printerService.assertRole(userId, printerId, 'operator');

    const existing = await printJobService.getById(jobId);
    if (!existing || existing.printerId !== printerId) {
      return next(AppError.notFound('Job not found', 'JOB_NOT_FOUND'));
    }

    const body = (req.body ?? {}) as { priority?: unknown };
    let priority = 0;
    if (body.priority !== undefined) {
      if (typeof body.priority !== 'number' || !Number.isInteger(body.priority)) {
        return next(AppError.badRequest('priority muss eine ganze Zahl sein.', 'BAD_PRIORITY'));
      }
      priority = Math.max(-1000, Math.min(1000, body.priority));
    }

    const approved = await printJobService.approveRequest(jobId, userId, priority);
    return res.status(200).json(approved);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/printer/:id/jobs/:jobId/reject — owner/operator turns
 * the request down. `reason` is required and shown to the submitter.
 */
const rejectJob = async (req: Request<{ id: string; jobId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id: printerId, jobId } = req.params;
    await printerService.assertRole(userId, printerId, 'operator');

    const existing = await printJobService.getById(jobId);
    if (!existing || existing.printerId !== printerId) {
      return next(AppError.notFound('Job not found', 'JOB_NOT_FOUND'));
    }

    const body = (req.body ?? {}) as { reason?: unknown };
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0 || body.reason.length > REJECTION_REASON_MAX) {
      return next(AppError.badRequest(
        `reason muss String 1–${REJECTION_REASON_MAX} Zeichen sein.`,
        'BAD_REASON'
      ));
    }

    const rejected = await printJobService.rejectRequest(jobId, userId, body.reason.trim());
    return res.status(200).json(rejected);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/printer/:id/jobs/:jobId/start — owner/operator explicitly
 * hands the job to the agent. Job must be in `queued` state. Refuses
 * if another job on the same printer is already in-flight.
 */
const startJob = async (req: Request<{ id: string; jobId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id: printerId, jobId } = req.params;
    await printerService.assertRole(userId, printerId, 'operator');

    const existing = await printJobService.getById(jobId);
    if (!existing || existing.printerId !== printerId) {
      return next(AppError.notFound('Job not found', 'JOB_NOT_FOUND'));
    }

    const started = await printJobService.startJob(jobId, userId);
    return res.status(200).json(started);
  } catch (err) {
    return next(err);
  }
};

const updatePriority = async (req: Request<{ id: string; jobId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id: printerId, jobId } = req.params;
    await printerService.assertRole(userId, printerId, 'operator');

    const body = (req.body ?? {}) as { priority?: unknown };
    if (typeof body.priority !== 'number' || !Number.isInteger(body.priority)) {
      return next(AppError.badRequest('priority muss eine ganze Zahl sein.', 'BAD_PRIORITY'));
    }
    const priority = Math.max(-1000, Math.min(1000, body.priority));

    const updated = await printJobService.updatePriority(jobId, priority);
    if (!updated) {
      return next(AppError.conflict(
        'Priorität nur änderbar solange Job `queued` ist.',
        'NOT_QUEUED'
      ));
    }
    if (updated.printerId !== printerId) {
      return next(AppError.notFound('Job not found', 'JOB_NOT_FOUND'));
    }
    return res.status(200).json(updated);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/printer/:id/jobs/:jobId/cancel — operator can cancel any
 * job; contributors/viewers can cancel only their own (and only while
 * it hasn't started yet; past `queued` is operator-territory).
 */
const cancelJob = async (req: Request<{ id: string; jobId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id: printerId, jobId } = req.params;
    const access = await printerService.getAccess(userId, printerId);

    const existing = await printJobService.getById(jobId);
    if (!existing || existing.printerId !== printerId) {
      return next(AppError.notFound('Job not found', 'JOB_NOT_FOUND'));
    }

    const isOwnerOp = access.role === 'owner' || access.role === 'operator';
    const isSubmitter = existing.userId === userId;

    if (!isOwnerOp) {
      if (!isSubmitter) {
        return next(AppError.forbidden('Nur eigene Jobs können abgebrochen werden.', 'NOT_OWN_JOB'));
      }
      // Submitters can cancel their own request/queued jobs but not
      // once they're in flight — the operator owns the live print.
      if (existing.state !== 'requested' && existing.state !== 'queued') {
        return next(AppError.forbidden(
          'Laufende Jobs kann nur ein Operator abbrechen.',
          'CANCEL_AFTER_START'
        ));
      }
    }

    const cancelled = await printJobService.cancelJob(jobId, `cancelled-by:${userId}`);
    return res.status(200).json(cancelled);
  } catch (err) {
    return next(err);
  }
};

/**
 * PUT /api/printer/:id/jobs/:jobId/gcode — swap the G-code attached to
 * a still-pending job. Submitter can do this to their own request
 * before approval; operator can do it in `queued` state too.
 */
const replaceGcode = async (req: Request<{ id: string; jobId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = requireUser(req);
    const { id: printerId, jobId } = req.params;
    const access = await printerService.getAccess(userId, printerId);

    const existing = await printJobService.getById(jobId);
    if (!existing || existing.printerId !== printerId) {
      return next(AppError.notFound('Job not found', 'JOB_NOT_FOUND'));
    }

    const isOwnerOp = access.role === 'owner' || access.role === 'operator';
    const isSubmitter = existing.userId === userId;
    if (!isOwnerOp && !isSubmitter) {
      return next(AppError.forbidden('Nur eigene Jobs sind editierbar.', 'NOT_OWN_JOB'));
    }
    if (!isOwnerOp && existing.state !== 'requested') {
      return next(AppError.forbidden(
        'Der Operator hat den Job schon genehmigt — frag ihn, falls ein Tausch nötig ist.',
        'LOCKED_AFTER_APPROVE'
      ));
    }

    const body = (req.body ?? {}) as { gcodeFileId?: unknown };
    const newFileId = assertUuid(body.gcodeFileId, 'gcodeFileId');
    const updated = await printJobService.replaceGcodeOnJob(jobId, newFileId);
    return res.status(200).json(updated);
  } catch (err) {
    return next(err);
  }
};

export default {
  listJobs,
  getCurrent,
  createRequest,
  getJob,
  approveJob,
  rejectJob,
  startJob,
  updatePriority,
  cancelJob,
  replaceGcode
};
