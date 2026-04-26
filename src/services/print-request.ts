import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import AppError from './error.js';
import type {
  PrintRequest,
  PrintRequestComment,
  PrintRequestCommentWithAuthor,
  PrintRequestSourceType,
  PrintRequestStatus,
  PrintRequestWithContext
} from '../models/index.js';

/**
 * Print-Request service.
 *
 * Two query layers:
 *   - "compact" (`printRequestCols`) for endpoints that don't need
 *     the requester / STL / printer names.
 *   - "with context" (`PRINT_REQUEST_COLUMNS_CTX`) for the list and
 *     detail views — joins user + stl_file + printer to spare the
 *     frontend N+1 lookups.
 *
 * Column projections are produced via tiny helpers so the same column
 * list works in three contexts:
 *   - SELECT with `FROM print_request pr` (alias = 'pr')
 *   - INSERT ... RETURNING (no FROM, alias must be empty)
 *   - UPDATE ... RETURNING (no AS alias on the table by default,
 *     so again unaliased)
 *
 * The original code used a hard-coded `pr.` prefix everywhere and
 * blew up on the INSERT path with `missing FROM-clause entry for
 * table "pr"` (Postgres 42P01).
 */
const prefix = (alias: string) => (alias ? `${alias}.` : '');

function printRequestCols(alias = ''): string {
  const p = prefix(alias);
  return `
    ${p}id,
    ${p}requester_user_id AS "requesterUserId",
    ${p}title,
    ${p}description,
    ${p}source_type AS "sourceType",
    ${p}stl_file_id AS "stlFileId",
    ${p}external_url AS "externalUrl",
    ${p}assigned_printer_id AS "assignedPrinterId",
    ${p}status,
    ${p}created_at AS "createdAt",
    ${p}updated_at AS "updatedAt"
  `;
}

function commentCols(alias = ''): string {
  const p = prefix(alias);
  return `
    ${p}id,
    ${p}request_id AS "requestId",
    ${p}author_user_id AS "authorUserId",
    ${p}body,
    ${p}created_at AS "createdAt"
  `;
}

const PRINT_REQUEST_COLUMNS_CTX = `
  ${printRequestCols('pr')},
  u.name AS "requesterName",
  u.display_name AS "requesterDisplayName",
  u.avatar_url AS "requesterAvatarUrl",
  sf.original_filename AS "stlFilename",
  p.name AS "printerName"
`;

const COMMENT_COLUMNS_CTX = `
  ${commentCols('c')},
  u.name AS "authorName",
  u.display_name AS "authorDisplayName",
  u.avatar_url AS "authorAvatarUrl"
`;

/**
 * Status transitions enforced server-side. Anyone can move into
 * `cancelled` from any non-terminal state (= the requester pulling
 * back), but moderators are the only ones who can shuffle through
 * `accepted`, `printing`, `done`, `rejected`. Terminal states are
 * one-way.
 */
const TERMINAL_STATUSES: ReadonlySet<PrintRequestStatus> = new Set([
  'done',
  'rejected',
  'cancelled'
]);

const VALID_TRANSITIONS: Record<PrintRequestStatus, ReadonlySet<PrintRequestStatus>> = {
  new: new Set(['accepted', 'rejected', 'cancelled']),
  accepted: new Set(['printing', 'rejected', 'cancelled']),
  printing: new Set(['done', 'rejected', 'cancelled']),
  done: new Set(),
  rejected: new Set(),
  cancelled: new Set()
};

export interface CreatePrintRequestOptions {
  requesterUserId: string;
  title: string;
  description?: string | null;
  source:
    | { type: 'stl_upload'; stlFileId: string }
    | { type: 'external_link'; externalUrl: string };
}

export interface PrintRequestFilter {
  /** When set, only the requester's own rows. Used by the user view. */
  requesterUserId?: string;
  status?: PrintRequestStatus | PrintRequestStatus[];
  limit?: number;
  offset?: number;
}

export interface UpdatePrintRequestOptions {
  status?: PrintRequestStatus;
  assignedPrinterId?: string | null;
}

export class PrintRequestService {
  async create(options: CreatePrintRequestOptions): Promise<PrintRequest> {
    const { requesterUserId, title, description = null, source } = options;

    const stlFileId = source.type === 'stl_upload' ? source.stlFileId : null;
    const externalUrl = source.type === 'external_link' ? source.externalUrl : null;

    // Pre-validate the FK so we surface a 404 instead of letting the
    // DB raise 23503 → 500. STL file must belong to the requester to
    // prevent cross-user file referencing.
    if (stlFileId) {
      const file = await persistence.database.query<{ uploaded_by_user_id: string | null }>(
        `SELECT uploaded_by_user_id FROM public."stl_file" WHERE id = $1::uuid`,
        [stlFileId]
      );
      if (file.rowCount === 0) {
        throw AppError.notFound('STL not found', 'STL_NOT_FOUND');
      }
      if (file.rows[0].uploaded_by_user_id !== requesterUserId) {
        throw AppError.forbidden('STL gehört einem anderen Nutzer.', 'STL_FOREIGN');
      }
    }

    const result: QueryResult<PrintRequest> = await persistence.database.query(
      `INSERT INTO public."print_request"
         (requester_user_id, title, description, source_type, stl_file_id, external_url)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)
       RETURNING ${printRequestCols()}`,
      [requesterUserId, title, description, source.type, stlFileId, externalUrl]
    );
    return result.rows[0];
  }

  /**
   * Lists requests with all the bits the UI needs to render a row
   * inline (requester display, STL filename if any, printer name if
   * assigned). The filter is applied AFTER the joins so the index on
   * `(requester_user_id, created_at DESC)` still kicks in.
   */
  async list(filter: PrintRequestFilter = {}): Promise<PrintRequestWithContext[]> {
    const { requesterUserId, status, limit = 50, offset = 0 } = filter;
    const params: unknown[] = [];
    const where: string[] = [];

    if (requesterUserId) {
      params.push(requesterUserId);
      where.push(`pr.requester_user_id = $${params.length}::uuid`);
    }
    if (status) {
      const statuses = Array.isArray(status) ? status : [status];
      params.push(statuses);
      where.push(`pr.status = ANY($${params.length}::varchar[])`);
    }
    params.push(limit, offset);

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const result: QueryResult<PrintRequestWithContext> = await persistence.database.query(
      `SELECT ${PRINT_REQUEST_COLUMNS_CTX}
       FROM public."print_request" pr
       JOIN public."user" u ON u.id = pr.requester_user_id
       LEFT JOIN public."stl_file" sf ON sf.id = pr.stl_file_id
       LEFT JOIN public."printer" p ON p.id = pr.assigned_printer_id
       ${whereClause}
       ORDER BY
         CASE pr.status
           WHEN 'new' THEN 0
           WHEN 'accepted' THEN 1
           WHEN 'printing' THEN 2
           WHEN 'done' THEN 3
           WHEN 'rejected' THEN 4
           WHEN 'cancelled' THEN 5
         END,
         pr.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return result.rows;
  }

  async getById(id: string): Promise<PrintRequestWithContext | null> {
    const result: QueryResult<PrintRequestWithContext> = await persistence.database.query(
      `SELECT ${PRINT_REQUEST_COLUMNS_CTX}
       FROM public."print_request" pr
       JOIN public."user" u ON u.id = pr.requester_user_id
       LEFT JOIN public."stl_file" sf ON sf.id = pr.stl_file_id
       LEFT JOIN public."printer" p ON p.id = pr.assigned_printer_id
       WHERE pr.id = $1::uuid`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Moderator update — status and/or printer assignment. Status
   * transitions are whitelisted; assigning a printer doesn't require
   * a status change (so the moderator can pick the printer ahead of
   * time without committing to "printing" yet).
   */
  async update(id: string, opts: UpdatePrintRequestOptions): Promise<PrintRequest> {
    const current = await this.getById(id);
    if (!current) {
      throw AppError.notFound('Druckanfrage not found', 'PRINT_REQUEST_NOT_FOUND');
    }

    const sets: string[] = [];
    const values: unknown[] = [];

    if (opts.status !== undefined && opts.status !== current.status) {
      if (!VALID_TRANSITIONS[current.status].has(opts.status)) {
        throw AppError.conflict(
          `Übergang ${current.status} → ${opts.status} ist nicht erlaubt.`,
          'BAD_STATUS_TRANSITION'
        );
      }
      values.push(opts.status);
      sets.push(`status = $${values.length}`);
    }
    if (opts.assignedPrinterId !== undefined) {
      values.push(opts.assignedPrinterId);
      sets.push(`assigned_printer_id = $${values.length}::uuid`);
    }
    if (sets.length === 0) {
      // No-op update — return current shape minus joins for
      // consistency with the typed `PrintRequest`.
      return this.stripContext(current);
    }
    sets.push('updated_at = NOW()');
    values.push(id);

    const result: QueryResult<PrintRequest> = await persistence.database.query(
      `UPDATE public."print_request"
       SET ${sets.join(', ')}
       WHERE id = $${values.length}::uuid
       RETURNING ${printRequestCols()}`,
      values
    );
    return result.rows[0];
  }

  /**
   * Requester-side cancel — works only on non-terminal requests and
   * only for the row's owner (caller verifies ownership before
   * dispatch). Goes through the same transition-validator as the
   * moderator update.
   */
  async cancel(id: string): Promise<PrintRequest> {
    const current = await this.getById(id);
    if (!current) {
      throw AppError.notFound('Druckanfrage not found', 'PRINT_REQUEST_NOT_FOUND');
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      throw AppError.conflict(
        `Anfrage ist im Endzustand (${current.status}) und kann nicht zurückgezogen werden.`,
        'PRINT_REQUEST_TERMINAL'
      );
    }
    const result: QueryResult<PrintRequest> = await persistence.database.query(
      `UPDATE public."print_request"
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1::uuid
       RETURNING ${printRequestCols()}`,
      [id]
    );
    return result.rows[0];
  }

  // ─── Comments ──────────────────────────────────────────────────────

  async listComments(requestId: string): Promise<PrintRequestCommentWithAuthor[]> {
    const result: QueryResult<PrintRequestCommentWithAuthor> = await persistence.database.query(
      `SELECT ${COMMENT_COLUMNS_CTX}
       FROM public."print_request_comment" c
       JOIN public."user" u ON u.id = c.author_user_id
       WHERE c.request_id = $1::uuid
       ORDER BY c.created_at ASC`,
      [requestId]
    );
    return result.rows;
  }

  async addComment(requestId: string, authorUserId: string, body: string): Promise<PrintRequestComment> {
    // Fail loudly if the request is gone — without this the CHECK
    // would catch length but a missing FK still gives 500-shaped
    // errors.
    const exists = await persistence.database.query<{ id: string }>(
      `SELECT id FROM public."print_request" WHERE id = $1::uuid`,
      [requestId]
    );
    if (exists.rowCount === 0) {
      throw AppError.notFound('Druckanfrage not found', 'PRINT_REQUEST_NOT_FOUND');
    }

    const result: QueryResult<PrintRequestComment> = await persistence.database.query(
      `INSERT INTO public."print_request_comment" (request_id, author_user_id, body)
       VALUES ($1::uuid, $2::uuid, $3)
       RETURNING ${commentCols()}`,
      [requestId, authorUserId, body]
    );
    return result.rows[0];
  }

  /** Casts a context row down to the bare PrintRequest shape. */
  private stripContext(row: PrintRequestWithContext): PrintRequest {
    const {
      requesterName: _name, requesterDisplayName: _dn, requesterAvatarUrl: _av,
      stlFilename: _sf, printerName: _pn, ...rest
    } = row;
    void _name; void _dn; void _av; void _sf; void _pn;
    return rest;
  }
}

export default new PrintRequestService();
