import { Request, Response, NextFunction } from 'express';
import persistence from '../services/persistence.js';

/**
 * GET /api/admin/dashboard-stats — Aggregierte Counts für die Dashboard-
 * Startseite. Liefert nur Zahlen, keine Datensätze — das Frontend zeigt
 * sie als Widget-Cards und verlinkt zu den jeweiligen Detail-Pages.
 *
 * Bewusst raw SQL statt Service-Aufrufe, weil wir nur COUNTs brauchen
 * und die Service-Methoden sonst die volle Liste laden würden.
 *
 * Permissions werden vom Mount-Pfad im Router (`adminGate`) geprüft.
 */

/** Helper: `COUNT(*) ... WHERE <predicate>` parallel ausführbar. Gibt
 *  den Zahlwert zurück (kein Cast in jeder Callsite). */
function countWhere(table: string, predicate: string): Promise<number> {
  return persistence.database
    .query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public."${table}" ${predicate}`
    )
    .then((q) => Number(q.rows[0]?.count ?? 0));
}

const stats = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      clipsPending,
      clipsFlagged,
      reportsOpen,
      blogPublished,
      blogDrafts,
      printRequestsOpen,
      usersTotal,
      usersNew30d,
      ratings7d,
      clipsApproved
    ] = await Promise.all([
      countWhere('clip', `WHERE status = 'pending'`),
      countWhere('clip', `WHERE status = 'flagged'`),
      countWhere('clip_report', `WHERE status = 'open'`),
      countWhere('blog_post', `WHERE published_at IS NOT NULL`),
      countWhere('blog_post', `WHERE published_at IS NULL`),
      countWhere('print_request', `WHERE status IN ('requested', 'approved', 'printing')`),
      countWhere('user', ''),
      countWhere('user', `WHERE created_at >= NOW() - INTERVAL '30 days'`),
      countWhere('clip_rating', `WHERE created_at >= NOW() - INTERVAL '7 days' AND score IS NOT NULL`),
      countWhere('clip', `WHERE status = 'approved'`)
    ]);

    return res.status(200).json({
      clips: {
        pending: clipsPending,
        flagged: clipsFlagged,
        approved: clipsApproved
      },
      reports: {
        open: reportsOpen
      },
      blog: {
        published: blogPublished,
        drafts: blogDrafts
      },
      printRequests: {
        open: printRequestsOpen
      },
      users: {
        total: usersTotal,
        new30d: usersNew30d
      },
      ratings: {
        last7d: ratings7d
      }
    });
  } catch (err) {
    return next(err);
  }
};

export default { stats };
