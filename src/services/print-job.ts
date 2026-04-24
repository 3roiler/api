import type { PoolClient, QueryResult } from 'pg';
import persistence from './persistence.js';
import AppError from './error.js';
import type { PrintJob, PrintJobState, PrintEvent } from '../models/index.js';

/**
 * Columns projected in every job query. `moonrakerJobId` is surfaced so
 * the user can cross-reference our queue with Moonraker's native history
 * after a reboot.
 */
const JOB_COLUMNS = `
  pj.id,
  pj.printer_id AS "printerId",
  pj.user_id AS "userId",
  pj.gcode_file_id AS "gcodeFileId",
  pj.state,
  pj.priority,
  pj.queued_at AS "queuedAt",
  pj.started_at AS "startedAt",
  pj.finished_at AS "finishedAt",
  pj.error_message AS "errorMessage",
  pj.moonraker_job_id AS "moonrakerJobId",
  pj.progress
`;

const EVENT_COLUMNS = `
  id,
  print_job_id AS "printJobId",
  event_type AS "eventType",
  payload,
  ts
`;

const TERMINAL_STATES: ReadonlySet<PrintJobState> = new Set([
  'completed',
  'failed',
  'cancelled'
]);

/** States the agent is allowed to report. Other targets must come from
 *  a human action in the dashboard (approve / reject / start / cancel).
 */
export const AGENT_ALLOWED_TARGETS: ReadonlySet<PrintJobState> = new Set([
  'printing',
  'paused',
  'completed',
  'failed'
]);

/** States the agent can see via `getCurrentForPrinter`. `transferring` is
 *  the handoff signal from dashboard → agent. `queued` is deliberately
 *  excluded — agents must not pre-fetch queued work on their own.
 */
const AGENT_VISIBLE_STATES: ReadonlySet<PrintJobState> = new Set([
  'transferring',
  'printing',
  'paused'
]);

/**
 * Whitelist of legal state-transitions. Humans and agents share the
 * state-machine, but the *controllers* restrict which transitions each
 * identity can request — see AGENT_ALLOWED_TARGETS for the agent side.
 */
const VALID_TRANSITIONS: Record<PrintJobState, ReadonlySet<PrintJobState>> = {
  requested: new Set(['queued', 'cancelled']),
  queued: new Set(['transferring', 'cancelled', 'failed']),
  transferring: new Set(['printing', 'failed', 'cancelled']),
  printing: new Set(['paused', 'completed', 'failed', 'cancelled']),
  paused: new Set(['printing', 'cancelled', 'failed']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

export interface CreateRequestOptions {
  printerId: string;
  userId: string;
  gcodeFileId: string;
}

export interface JobFilter {
  /** Omit to include every state. */
  state?: PrintJobState | PrintJobState[];
  /** Restrict to a single user — used for contributors who can only see
   *  their own submissions. */
  userId?: string;
  limit?: number;
  offset?: number;
}

export interface StateTransitionPatch {
  progress?: number;
  errorMessage?: string;
  moonrakerJobId?: string;
}

export class PrintJobService {
  /**
   * Creates a job in the `requested` state. The owner/operator must
   * explicitly approve it to advance to `queued`. Used by
   * contributor+ for self-service submissions.
   */
  async createRequest(options: CreateRequestOptions): Promise<PrintJob> {
    const { printerId, userId, gcodeFileId } = options;

    const fileExists = await persistence.database.query<{ id: string }>(
      `SELECT id FROM public."gcode_file" WHERE id = $1::uuid`,
      [gcodeFileId]
    );
    if (fileExists.rowCount === 0) {
      throw AppError.notFound('G-code not found', 'GCODE_NOT_FOUND');
    }

    const result: QueryResult<PrintJob> = await persistence.database.query(
      `INSERT INTO public."print_job"
         (printer_id, user_id, gcode_file_id, state, priority)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'requested', 0)
       RETURNING ${JOB_COLUMNS}`,
      [printerId, userId, gcodeFileId]
    );
    await this.recordEvent(result.rows[0].id, 'requested', { userId });
    return result.rows[0];
  }

  async listForPrinter(printerId: string, filter: JobFilter = {}): Promise<PrintJob[]> {
    const { state, userId, limit = 50, offset = 0 } = filter;
    const params: unknown[] = [printerId];
    let stateClause = '';
    if (state) {
      const states = Array.isArray(state) ? state : [state];
      params.push(states);
      stateClause = `AND pj.state = ANY($${params.length}::varchar[])`;
    }
    let userClause = '';
    if (userId) {
      params.push(userId);
      userClause = `AND pj.user_id = $${params.length}::uuid`;
    }
    params.push(limit, offset);

    const result: QueryResult<PrintJob> = await persistence.database.query(
      `SELECT ${JOB_COLUMNS}
       FROM public."print_job" pj
       WHERE pj.printer_id = $1::uuid ${stateClause} ${userClause}
       ORDER BY
         CASE pj.state
           WHEN 'printing' THEN 0
           WHEN 'paused' THEN 1
           WHEN 'transferring' THEN 2
           WHEN 'queued' THEN 3
           WHEN 'requested' THEN 4
           ELSE 5
         END,
         pj.priority DESC,
         pj.queued_at ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return result.rows;
  }

  async getById(jobId: string): Promise<PrintJob | null> {
    const result: QueryResult<PrintJob> = await persistence.database.query(
      `SELECT ${JOB_COLUMNS} FROM public."print_job" pj WHERE pj.id = $1::uuid`,
      [jobId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Agent-facing single-job lookup. Returns the job currently handed to
   * the printer (states `transferring`, `printing`, `paused`) or null.
   * The agent never sees `queued` or `requested` — a human has to
   * explicitly start one of those before the printer can touch it.
   */
  async getCurrentForPrinter(printerId: string): Promise<PrintJob | null> {
    const result: QueryResult<PrintJob> = await persistence.database.query(
      `SELECT ${JOB_COLUMNS}
       FROM public."print_job" pj
       WHERE pj.printer_id = $1::uuid
         AND pj.state IN ('transferring','printing','paused')
       ORDER BY pj.started_at DESC NULLS LAST
       LIMIT 1`,
      [printerId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Owner/operator approves a request. Optionally sets the initial
   * priority — without it the job joins the queue at priority 0.
   */
  async approveRequest(jobId: string, approverUserId: string, priority = 0): Promise<PrintJob> {
    return this.withTx(async (client) => {
      const current = await client.query<{ state: PrintJobState }>(
        `SELECT state FROM public."print_job"
         WHERE id = $1::uuid
         FOR UPDATE`,
        [jobId]
      );
      const state = current.rows[0]?.state;
      if (!state) {
        throw AppError.notFound('Job not found', 'JOB_NOT_FOUND');
      }
      if (state !== 'requested') {
        throw AppError.conflict(
          `Nur Anfragen (requested) können genehmigt werden. Aktuell: ${state}.`,
          'NOT_REQUESTED'
        );
      }

      const updated: QueryResult<PrintJob> = await client.query(
        `UPDATE public."print_job"
         SET state = 'queued',
             priority = $2
         WHERE id = $1::uuid
         RETURNING ${JOB_COLUMNS}`,
        [jobId, priority]
      );
      await client.query(
        `INSERT INTO public."print_event" (print_job_id, event_type, payload)
         VALUES ($1::uuid, 'approved', $2::jsonb)`,
        [jobId, JSON.stringify({ approverUserId, priority })]
      );
      return updated.rows[0];
    });
  }

  /**
   * Rejects a request. Uses the `cancelled` terminal state and records
   * the rejection reason in `error_message` — keeps the job history
   * queryable without a separate rejection table.
   */
  async rejectRequest(jobId: string, rejecterUserId: string, reason: string): Promise<PrintJob> {
    return this.withTx(async (client) => {
      const current = await client.query<{ state: PrintJobState }>(
        `SELECT state FROM public."print_job"
         WHERE id = $1::uuid
         FOR UPDATE`,
        [jobId]
      );
      const state = current.rows[0]?.state;
      if (!state) {
        throw AppError.notFound('Job not found', 'JOB_NOT_FOUND');
      }
      if (state !== 'requested') {
        throw AppError.conflict(
          `Nur Anfragen (requested) können abgelehnt werden. Aktuell: ${state}.`,
          'NOT_REQUESTED'
        );
      }

      const updated: QueryResult<PrintJob> = await client.query(
        `UPDATE public."print_job"
         SET state = 'cancelled',
             finished_at = NOW(),
             error_message = $2
         WHERE id = $1::uuid
         RETURNING ${JOB_COLUMNS}`,
        [jobId, reason]
      );
      await client.query(
        `INSERT INTO public."print_event" (print_job_id, event_type, payload)
         VALUES ($1::uuid, 'rejected', $2::jsonb)`,
        [jobId, JSON.stringify({ rejecterUserId, reason })]
      );
      return updated.rows[0];
    });
  }

  /**
   * Owner/operator signals the agent: this is the next one. Moves
   * `queued → transferring`. The agent's next poll will pick it up. Only
   * one job at a time can be in handoff — if another is already
   * `transferring` or further we refuse so the operator can't
   * accidentally fork the queue.
   */
  async startJob(jobId: string, starterUserId: string): Promise<PrintJob> {
    return this.withTx(async (client) => {
      const target = await client.query<{ state: PrintJobState; printer_id: string }>(
        `SELECT state, printer_id
         FROM public."print_job"
         WHERE id = $1::uuid
         FOR UPDATE`,
        [jobId]
      );
      const row = target.rows[0];
      if (!row) {
        throw AppError.notFound('Job not found', 'JOB_NOT_FOUND');
      }
      if (row.state !== 'queued') {
        throw AppError.conflict(
          `Nur Jobs im Zustand queued können gestartet werden. Aktuell: ${row.state}.`,
          'NOT_QUEUED'
        );
      }

      // Make sure nothing else is already in progress on this printer.
      // Using FOR KEY SHARE so we don't block each other — we only need
      // to observe, not mutate.
      const busy = await client.query<{ id: string; state: PrintJobState }>(
        `SELECT id, state FROM public."print_job"
         WHERE printer_id = $1::uuid
           AND state IN ('transferring','printing','paused')
           AND id <> $2::uuid
         LIMIT 1`,
        [row.printer_id, jobId]
      );
      if (busy.rows.length > 0) {
        throw AppError.conflict(
          `Drucker ist bereits mit Job ${busy.rows[0].id} (${busy.rows[0].state}) beschäftigt.`,
          'PRINTER_BUSY'
        );
      }

      const updated: QueryResult<PrintJob> = await client.query(
        `UPDATE public."print_job"
         SET state = 'transferring',
             started_at = NOW()
         WHERE id = $1::uuid
         RETURNING ${JOB_COLUMNS}`,
        [jobId]
      );
      await client.query(
        `INSERT INTO public."print_event" (print_job_id, event_type, payload)
         VALUES ($1::uuid, 'transferring', $2::jsonb)`,
        [jobId, JSON.stringify({ starterUserId })]
      );
      return updated.rows[0];
    });
  }

  /**
   * Updates priority on a queued job. Refuses once the job is past the
   * queue (running jobs can't meaningfully reorder). Requests in state
   * `requested` use the `approveRequest(..., priority)` path instead.
   */
  async updatePriority(jobId: string, priority: number): Promise<PrintJob | null> {
    const result: QueryResult<PrintJob> = await persistence.database.query(
      `UPDATE public."print_job" pj
       SET priority = $1
       WHERE pj.id = $2::uuid AND pj.state = 'queued'
       RETURNING ${JOB_COLUMNS}`,
      [priority, jobId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * User/operator initiated cancel. Allowed in any non-terminal state.
   * Sets `finished_at` even for pre-run cancellations so "time in
   * queue" math works uniformly.
   */
  async cancelJob(jobId: string, reason = 'user-cancel'): Promise<PrintJob | null> {
    return this.withTx(async (client) => {
      const current = await client.query<{ state: PrintJobState }>(
        `SELECT state FROM public."print_job"
         WHERE id = $1::uuid
         FOR UPDATE`,
        [jobId]
      );
      const state = current.rows[0]?.state;
      if (!state) return null;
      if (TERMINAL_STATES.has(state)) {
        throw AppError.conflict(
          `Job ist im Endzustand (${state}) und kann nicht abgebrochen werden.`,
          'JOB_TERMINAL'
        );
      }

      const updated: QueryResult<PrintJob> = await client.query(
        `UPDATE public."print_job"
         SET state = 'cancelled',
             finished_at = NOW(),
             error_message = COALESCE(error_message, $2)
         WHERE id = $1::uuid
         RETURNING ${JOB_COLUMNS}`,
        [jobId, reason]
      );
      await client.query(
        `INSERT INTO public."print_event" (print_job_id, event_type, payload)
         VALUES ($1::uuid, 'cancelled', $2::jsonb)`,
        [jobId, JSON.stringify({ reason })]
      );
      return updated.rows[0] ?? null;
    });
  }

  /**
   * Agent-driven state transition. Validates against `VALID_TRANSITIONS`
   * *and* against AGENT_ALLOWED_TARGETS (enforced in the controller) so
   * a buggy / compromised agent cannot approve its own jobs. When the
   * target state is terminal, `finished_at` is stamped.
   */
  async transitionState(
    jobId: string,
    printerId: string,
    target: PrintJobState,
    patch: StateTransitionPatch = {}
  ): Promise<PrintJob> {
    return this.withTx(async (client) => {
      const current = await client.query<{ state: PrintJobState }>(
        `SELECT state FROM public."print_job"
         WHERE id = $1::uuid AND printer_id = $2::uuid
         FOR UPDATE`,
        [jobId, printerId]
      );
      const state = current.rows[0]?.state;
      if (!state) {
        throw AppError.notFound('Job not found', 'JOB_NOT_FOUND');
      }
      if (!VALID_TRANSITIONS[state].has(target)) {
        throw AppError.conflict(
          `Ungültiger Übergang: ${state} → ${target}.`,
          'BAD_TRANSITION'
        );
      }

      const setFragments = ['state = $3'];
      const values: unknown[] = [jobId, printerId, target];

      if (TERMINAL_STATES.has(target)) {
        setFragments.push('finished_at = NOW()');
      }
      if (target === 'printing' && state === 'transferring') {
        // First transition out of transfer — overwrite `started_at` so
        // it reflects head's actual first layer, not when we handed
        // the file over.
        setFragments.push('started_at = NOW()');
      }
      if (patch.progress !== undefined) {
        values.push(Math.max(0, Math.min(1, patch.progress)));
        setFragments.push(`progress = $${values.length}`);
      }
      if (patch.errorMessage !== undefined) {
        values.push(patch.errorMessage);
        setFragments.push(`error_message = $${values.length}`);
      }
      if (patch.moonrakerJobId !== undefined) {
        values.push(patch.moonrakerJobId);
        setFragments.push(`moonraker_job_id = $${values.length}`);
      }

      const updated: QueryResult<PrintJob> = await client.query(
        `UPDATE public."print_job"
         SET ${setFragments.join(', ')}
         WHERE id = $1::uuid AND printer_id = $2::uuid
         RETURNING ${JOB_COLUMNS}`,
        values
      );

      await client.query(
        `INSERT INTO public."print_event" (print_job_id, event_type, payload)
         VALUES ($1::uuid, $2, $3::jsonb)`,
        [jobId, target, JSON.stringify(patch)]
      );
      return updated.rows[0];
    });
  }

  /**
   * Lightweight progress ping — the printer emits these every couple of
   * seconds and we don't want one `print_event` row per tick. We only
   * write an event when progress crosses a 5%-bucket; otherwise we just
   * patch the `progress` column.
   */
  async updateProgress(jobId: string, printerId: string, progress: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, progress));
    const prior = await persistence.database.query<{ progress: number | null }>(
      `SELECT progress FROM public."print_job"
       WHERE id = $1::uuid AND printer_id = $2::uuid`,
      [jobId, printerId]
    );
    const prev = prior.rows[0]?.progress ?? 0;

    await persistence.database.query(
      `UPDATE public."print_job"
       SET progress = $1
       WHERE id = $2::uuid AND printer_id = $3::uuid`,
      [clamped, jobId, printerId]
    );

    const bucket = (p: number) => Math.floor(p * 20); // 5% resolution
    if (bucket(clamped) > bucket(prev)) {
      await this.recordEvent(jobId, 'progress', { progress: clamped });
    }
  }

  /**
   * Replaces the G-code referenced by a still-pending job. Used by the
   * in-browser editor: submitter edits the file, saves → new
   * `gcode_file` row, job updates its pointer. Refuses once the agent
   * has the file (transferring or beyond) — you don't want to swap
   * mid-print.
   */
  async replaceGcodeOnJob(jobId: string, newFileId: string): Promise<PrintJob> {
    return this.withTx(async (client) => {
      const current = await client.query<{ state: PrintJobState }>(
        `SELECT state FROM public."print_job"
         WHERE id = $1::uuid
         FOR UPDATE`,
        [jobId]
      );
      const state = current.rows[0]?.state;
      if (!state) {
        throw AppError.notFound('Job not found', 'JOB_NOT_FOUND');
      }
      if (state !== 'requested' && state !== 'queued') {
        throw AppError.conflict(
          `G-Code kann nur getauscht werden solange der Job requested oder queued ist. Aktuell: ${state}.`,
          'JOB_IN_FLIGHT'
        );
      }

      const fileExists = await client.query<{ id: string }>(
        `SELECT id FROM public."gcode_file" WHERE id = $1::uuid`,
        [newFileId]
      );
      if (fileExists.rowCount === 0) {
        throw AppError.notFound('G-code not found', 'GCODE_NOT_FOUND');
      }

      const updated: QueryResult<PrintJob> = await client.query(
        `UPDATE public."print_job"
         SET gcode_file_id = $1::uuid
         WHERE id = $2::uuid
         RETURNING ${JOB_COLUMNS}`,
        [newFileId, jobId]
      );
      await client.query(
        `INSERT INTO public."print_event" (print_job_id, event_type, payload)
         VALUES ($1::uuid, 'gcode_replaced', $2::jsonb)`,
        [jobId, JSON.stringify({ newFileId })]
      );
      return updated.rows[0];
    });
  }

  async recordEvent(jobId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<PrintEvent> {
    const result: QueryResult<PrintEvent> = await persistence.database.query(
      `INSERT INTO public."print_event" (print_job_id, event_type, payload)
       VALUES ($1::uuid, $2, $3::jsonb)
       RETURNING ${EVENT_COLUMNS}`,
      [jobId, eventType, JSON.stringify(payload)]
    );
    return result.rows[0];
  }

  async listEvents(jobId: string, limit = 100): Promise<PrintEvent[]> {
    const result: QueryResult<PrintEvent> = await persistence.database.query(
      `SELECT ${EVENT_COLUMNS}
       FROM public."print_event"
       WHERE print_job_id = $1::uuid
       ORDER BY ts DESC
       LIMIT $2`,
      [jobId, limit]
    );
    return result.rows;
  }

  private async withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await persistence.database.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

// Export the agent-visibility set so the agent controller can also
// surface it in responses (or tests).
export { AGENT_VISIBLE_STATES };

export default new PrintJobService();
