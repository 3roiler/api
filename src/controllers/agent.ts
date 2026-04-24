import { Request, Response, NextFunction } from 'express';
import {
  printer as printerService,
  printJob as printJobService,
  gcode as gcodeService
} from '../services/index.js';
import persistence from '../services/persistence.js';
import AppError from '../services/error.js';
import { AGENT_ALLOWED_TARGETS } from '../services/print-job.js';
import type { PrinterStatus, PrintJobState } from '../models/index.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- See services/system.ts, Express augmentation convention.
  namespace Express {
    interface Request {
      printerId?: string;
    }
  }
}

const AGENT_TOKEN_HEADER = 'x-agent-token';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES: PrinterStatus[] = ['offline', 'online', 'error'];

function requirePrinter(req: Request): string {
  if (!req.printerId) {
    throw AppError.unauthorized('Agent not authenticated.');
  }
  return req.printerId;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(`\`${field}\` must be a UUID.`, 'BAD_UUID');
  }
  return value;
}

/**
 * Middleware: verifies `X-Agent-Token` and populates `req.printerId`.
 * The header is hashed and compared against `printer.agent_token_hash`.
 * On match we also touch `last_seen_at` so the dashboard reflects the
 * ping without waiting for an explicit heartbeat.
 */
export const agentAuthHandler = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const raw = req.header(AGENT_TOKEN_HEADER);
    if (!raw || typeof raw !== 'string' || raw.length < 32) {
      return next(AppError.unauthorized(
        `Missing or malformed \`${AGENT_TOKEN_HEADER}\` header.`,
        'AGENT_UNAUTH'
      ));
    }
    const printer = await printerService.findByAgentToken(raw);
    if (!printer) {
      return next(AppError.unauthorized('Agent token rejected.', 'AGENT_UNAUTH'));
    }
    req.printerId = printer.id;

    // Every authenticated call is also a presence signal. We don't await
    // the status write so a slow DB doesn't bottleneck the poll loop,
    // but we surface errors to the logger.
    printerService.updateStatus(printer.id, { touchLastSeen: true })
      .catch((err) => console.error('[agent] touchLastSeen failed:', err));

    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/agent/heartbeat
 *   Body: { status: 'online'|'offline'|'error', agentVersion?: string }
 *   Low-churn presence ping. Idempotent — the agent calls this every
 *   5-10s with the Moonraker-derived status.
 */
const heartbeat = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const printerId = requirePrinter(req);
    const body = (req.body ?? {}) as { status?: unknown; agentVersion?: unknown };

    let status: PrinterStatus | undefined;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !VALID_STATUSES.includes(body.status as PrinterStatus)) {
        return next(AppError.badRequest(
          `status muss einer von: ${VALID_STATUSES.join(', ')} sein.`,
          'BAD_STATUS'
        ));
      }
      status = body.status as PrinterStatus;
    }

    let agentVersion: string | null | undefined;
    if (body.agentVersion !== undefined) {
      if (body.agentVersion !== null && typeof body.agentVersion !== 'string') {
        return next(AppError.badRequest('agentVersion muss String oder null sein.', 'BAD_VERSION'));
      }
      agentVersion = body.agentVersion === null ? null : String(body.agentVersion).slice(0, 40);
    }

    await printerService.updateStatus(printerId, {
      status,
      agentVersion,
      touchLastSeen: true
    });
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/agent/jobs/current
 *   Returns the single job currently assigned to this printer —
 *   whichever is in state `transferring`, `printing`, or `paused`.
 *   Returns 204 when the printer is idle. The agent has **no** way to
 *   pull `queued` or `requested` jobs on its own — an operator must
 *   explicitly start one via the dashboard.
 */
const currentJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const printerId = requirePrinter(req);
    const job = await printJobService.getCurrentForPrinter(printerId);
    if (!job) return res.status(204).send();
    return res.status(200).json(job);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/agent/jobs/:jobId/transition
 *   Body: { state, progress?, errorMessage?, moonrakerJobId? }
 *   Moves the job through the state-machine. The service rejects illegal
 *   transitions with a 409, so a re-send on network hiccup is safe: the
 *   same transition twice is idempotent on the DB side *except* the
 *   second call will 409 because current state already matches target.
 *   Agents MUST swallow 409 as "already applied".
 */
const transition = async (req: Request<{ jobId: string }>, res: Response, next: NextFunction) => {
  try {
    const printerId = requirePrinter(req);
    const { jobId } = req.params;
    const body = (req.body ?? {}) as {
      state?: unknown;
      progress?: unknown;
      errorMessage?: unknown;
      moonrakerJobId?: unknown;
    };

    if (typeof body.state !== 'string' || !AGENT_ALLOWED_TARGETS.has(body.state as PrintJobState)) {
      return next(AppError.badRequest(
        `state muss einer von: ${Array.from(AGENT_ALLOWED_TARGETS).join(', ')} sein.`,
        'BAD_STATE'
      ));
    }
    const target = body.state as PrintJobState;

    const patch: {
      progress?: number;
      errorMessage?: string;
      moonrakerJobId?: string;
    } = {};
    if (body.progress !== undefined) {
      if (typeof body.progress !== 'number' || Number.isNaN(body.progress)) {
        return next(AppError.badRequest('progress muss Zahl zwischen 0 und 1 sein.', 'BAD_PROGRESS'));
      }
      patch.progress = body.progress;
    }
    if (body.errorMessage !== undefined) {
      if (body.errorMessage !== null && typeof body.errorMessage !== 'string') {
        return next(AppError.badRequest('errorMessage muss String oder null sein.', 'BAD_ERROR'));
      }
      patch.errorMessage = body.errorMessage === null ? undefined : String(body.errorMessage).slice(0, 1024);
    }
    if (body.moonrakerJobId !== undefined) {
      if (typeof body.moonrakerJobId !== 'string' || body.moonrakerJobId.length > 80) {
        return next(AppError.badRequest('moonrakerJobId muss String ≤ 80 Zeichen sein.', 'BAD_MOONRAKER_ID'));
      }
      patch.moonrakerJobId = body.moonrakerJobId;
    }

    const updated = await printJobService.transitionState(jobId, printerId, target, patch);
    return res.status(200).json(updated);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/agent/jobs/:jobId/progress  { progress: 0..1 }
 *   High-frequency channel that doesn't spam `print_event` — the service
 *   only writes an event when crossing 5%-buckets. Anything denser is
 *   just the `progress` column moving.
 */
const progress = async (req: Request<{ jobId: string }>, res: Response, next: NextFunction) => {
  try {
    const printerId = requirePrinter(req);
    const { jobId } = req.params;
    const body = (req.body ?? {}) as { progress?: unknown };
    if (typeof body.progress !== 'number' || Number.isNaN(body.progress)) {
      return next(AppError.badRequest('progress muss Zahl zwischen 0 und 1 sein.', 'BAD_PROGRESS'));
    }
    await printJobService.updateProgress(jobId, printerId, body.progress);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/agent/jobs/:jobId/event  { eventType, payload? }
 *   Free-form event sink so the agent can attach Moonraker-side facts
 *   (layer change, z-shift, chamber temp, thumbnail) to the job timeline
 *   without us mapping every one. `eventType` is capped at 40 chars to
 *   match the DB column.
 */
const event = async (req: Request<{ jobId: string }>, res: Response, next: NextFunction) => {
  try {
    const printerId = requirePrinter(req);
    const { jobId } = req.params;
    const body = (req.body ?? {}) as { eventType?: unknown; payload?: unknown };

    if (typeof body.eventType !== 'string' || body.eventType.length === 0 || body.eventType.length > 40) {
      return next(AppError.badRequest(
        'eventType muss String 1–40 Zeichen sein.',
        'BAD_EVENT_TYPE'
      ));
    }
    let payload: Record<string, unknown> = {};
    if (body.payload !== undefined) {
      if (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload)) {
        return next(AppError.badRequest('payload muss Objekt sein.', 'BAD_PAYLOAD'));
      }
      payload = body.payload as Record<string, unknown>;
    }

    // Verify the job belongs to this printer — otherwise a compromised
    // agent token could graffiti events onto other printers' jobs.
    const job = await printJobService.getById(jobId);
    if (!job || job.printerId !== printerId) {
      return next(AppError.notFound('Job not found', 'JOB_NOT_FOUND'));
    }

    const recorded = await printJobService.recordEvent(jobId, body.eventType, payload);
    return res.status(201).json(recorded);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/agent/gcode/:id/download
 *   Streams the bytea blob to the agent. Printer must have at least one
 *   queued/running job referencing this file — prevents a leaked token
 *   from exfiltrating the entire file library. Response is
 *   `application/octet-stream` with `X-Filename` + `X-Sha256` so the
 *   agent can verify-and-cache without a second metadata call.
 */
const downloadGcode = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const printerId = requirePrinter(req);
    const { id: fileId } = req.params;
    assertUuid(fileId, 'id');

    const meta = await gcodeService.getById(fileId);
    if (!meta) {
      return next(AppError.notFound('G-code not found', 'GCODE_NOT_FOUND'));
    }

    // Strict: only the *currently-assigned* job can fetch its G-code.
    // This closes the door on an agent pre-fetching files for queued
    // jobs (which it must not know about anyway) or re-downloading
    // historical prints. If the file is needed, the operator starts
    // the job, which flips it to transferring — *then* the agent can
    // download.
    const relation = await persistence.database.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM public."print_job"
       WHERE printer_id = $1::uuid
         AND gcode_file_id = $2::uuid
         AND state IN ('transferring','printing','paused')`,
      [printerId, fileId]
    );
    if (Number(relation.rows[0]?.cnt ?? 0) === 0) {
      return next(AppError.forbidden(
        'G-code nicht für diesen Drucker freigegeben.',
        'GCODE_NOT_FOR_PRINTER'
      ));
    }

    const content = await gcodeService.getContent(fileId);
    if (!content) {
      // getById returned metadata but the content row is gone — schema
      // says CASCADE, so this is a data-integrity 500, not a 404.
      return next(AppError.internal('G-code content missing.', 'GCODE_CONTENT_MISSING'));
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', meta.sizeBytes.toString());
    res.setHeader('X-Filename', meta.originalFilename);
    res.setHeader('X-Sha256', meta.sha256);
    // No Content-Disposition: agent never serves this to a browser. A
    // leaked download URL shouldn't nudge curl into saving to a filename
    // the attacker chose.
    return res.status(200).send(content);
  } catch (err) {
    return next(err);
  }
};

export default {
  heartbeat,
  currentJob,
  transition,
  progress,
  event,
  downloadGcode
};
