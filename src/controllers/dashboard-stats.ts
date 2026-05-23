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
const stats = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const queries = await Promise.all([
      // Clips in Moderation
      persistence.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public."clip" WHERE status = 'pending'`
      ),
      // Clips als gemeldet markiert
      persistence.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public."clip" WHERE status = 'flagged'`
      ),
      // Offene Clip-Reports
      persistence.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public."clip_report" WHERE status = 'open'`
      ),
      // Veröffentlichte Blog-Posts
      persistence.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public."blog_post" WHERE published_at IS NOT NULL`
      ),
      // Blog-Drafts
      persistence.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public."blog_post" WHERE published_at IS NULL`
      ),
      // Druckanfragen (offen — Status `requested`/`approved`/`printing`)
      persistence.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public."print_request"
         WHERE status IN ('requested', 'approved', 'printing')`
      ),
      // User-Total
      persistence.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public."user"`
      ),
      // Neue User in den letzten 30 Tagen
      persistence.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public."user"
         WHERE created_at >= NOW() - INTERVAL '30 days'`
      ),
      // Neue Bewertungen in den letzten 7 Tagen
      persistence.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public."clip_rating"
         WHERE created_at >= NOW() - INTERVAL '7 days' AND score IS NOT NULL`
      ),
      // Freigegebene Clips (für Ratio-Anzeige)
      persistence.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public."clip" WHERE status = 'approved'`
      )
    ]);

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
    ] = queries.map((q) => Number(q.rows[0]?.count ?? 0));

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
