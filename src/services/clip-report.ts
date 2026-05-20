import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import AppError from './error.js';
import type { ClipReport, ClipReportStatus } from '../models/index.js';

/**
 * Clip-Meldungen. Eine Meldung ändert bewusst NICHT automatisch den
 * Clip-Status (sonst könnte eine einzelne böswillige Meldung einen
 * freigegebenen Clip aus dem Feed kippen) — der Moderator sichtet die
 * offenen Meldungen und entscheidet manuell.
 */
const REPORT_COLUMNS = `
  id,
  clip_id AS "clipId",
  reporter_user_id AS "reporterUserId",
  reason,
  status,
  created_at AS "createdAt",
  resolved_at AS "resolvedAt",
  resolved_by AS "resolvedBy"
`;

export interface ClipReportWithContext extends ClipReport {
  reporterName: string;
  clipTitle: string;
  clipStatus: string;
  clipThumbnailUrl: string | null;
}

export class ClipReportService {
  async create(clipId: string, reporterUserId: string, reason: string): Promise<ClipReport> {
    const clip = await persistence.database.query<{ id: string }>(
      `SELECT id FROM public."clip" WHERE id = $1::uuid`,
      [clipId]
    );
    if (clip.rowCount === 0) {
      throw AppError.notFound('Clip nicht gefunden.', 'CLIP_NOT_FOUND');
    }

    const result: QueryResult<ClipReport> = await persistence.database.query(
      `INSERT INTO public."clip_report" (clip_id, reporter_user_id, reason)
       VALUES ($1::uuid, $2::uuid, $3)
       RETURNING ${REPORT_COLUMNS}`,
      [clipId, reporterUserId, reason]
    );
    return result.rows[0];
  }

  async list(status: ClipReportStatus = 'open', limit = 50, offset = 0): Promise<ClipReportWithContext[]> {
    const result: QueryResult<ClipReportWithContext> = await persistence.database.query(
      `SELECT rep.id,
              rep.clip_id AS "clipId",
              rep.reporter_user_id AS "reporterUserId",
              rep.reason,
              rep.status,
              rep.created_at AS "createdAt",
              rep.resolved_at AS "resolvedAt",
              rep.resolved_by AS "resolvedBy",
              u.name AS "reporterName",
              c.title AS "clipTitle",
              c.status AS "clipStatus",
              c.thumbnail_url AS "clipThumbnailUrl"
       FROM public."clip_report" rep
       JOIN public."user" u ON u.id = rep.reporter_user_id
       JOIN public."clip" c ON c.id = rep.clip_id
       WHERE rep.status = $1
       ORDER BY rep.created_at DESC
       LIMIT $2 OFFSET $3`,
      [status, Math.min(limit, 100), Math.max(offset, 0)]
    );
    return result.rows;
  }

  async resolve(id: string, resolvedBy: string, status: Exclude<ClipReportStatus, 'open'>): Promise<ClipReport> {
    const result: QueryResult<ClipReport> = await persistence.database.query(
      `UPDATE public."clip_report"
       SET status = $2, resolved_at = NOW(), resolved_by = $3::uuid
       WHERE id = $1::uuid
       RETURNING ${REPORT_COLUMNS}`,
      [id, status, resolvedBy]
    );
    if (!result.rows[0]) throw AppError.notFound('Meldung nicht gefunden.', 'REPORT_NOT_FOUND');
    return result.rows[0];
  }
}

export default new ClipReportService();
