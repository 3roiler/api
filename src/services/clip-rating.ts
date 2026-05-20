import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import AppError from './error.js';
import awardCategory from './award-category.js';
import type { ClipRating } from '../models/index.js';

/**
 * Bewertungen — eine Zeile pro (Clip, Nutzer). Eine Bewertung ist
 * entweder ein Score 1–5 ODER ein Skip/Enthalten (DB-CHECK erzwingt das
 * XOR). Die Award-Stimmen hängen als m:n an der Bewertung.
 *
 * Re-Bewerten ist erlaubt (ON CONFLICT DO UPDATE) — eine
 * Meinungsänderung überschreibt die alte Bewertung samt Award-Stimmen.
 */
function ratingCols(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  return `
    ${p}id,
    ${p}clip_id AS "clipId",
    ${p}user_id AS "userId",
    ${p}score,
    ${p}is_skipped AS "isSkipped",
    ${p}created_at AS "createdAt",
    ${p}updated_at AS "updatedAt"
  `;
}

export interface RateInput {
  /** 1–5 bei Bewertung, sonst null. */
  score: number | null;
  /** IDs aktiver Award-Kategorien (bei Skip ignoriert). */
  awardIds: string[];
  /** true = Enthaltung; dann score === null. */
  skipped: boolean;
}

export class ClipRatingService {
  /**
   * Bewertung abgeben/aktualisieren. Validiert Clip-Existenz, dass der
   * Clip freigegeben ist und dass es nicht der eigene Clip ist
   * (Self-Vote-Sperre). Award-IDs werden gegen die aktiven Kategorien
   * gefiltert. Alles in einer Transaktion.
   */
  async rate(userId: string, clipId: string, input: RateInput): Promise<ClipRating> {
    const clip = await persistence.database.query<{ submitted_by_user_id: string; status: string }>(
      `SELECT submitted_by_user_id, status FROM public."clip" WHERE id = $1::uuid`,
      [clipId]
    );
    if (clip.rowCount === 0) {
      throw AppError.notFound('Clip nicht gefunden.', 'CLIP_NOT_FOUND');
    }
    if (clip.rows[0].status !== 'approved') {
      throw AppError.conflict('Clip ist nicht freigegeben.', 'CLIP_NOT_APPROVED');
    }
    if (clip.rows[0].submitted_by_user_id === userId) {
      throw AppError.forbidden('Eigene Clips können nicht bewertet werden.', 'SELF_VOTE');
    }

    const validAwardIds = input.skipped ? [] : await awardCategory.filterValidActiveIds(input.awardIds);

    const client = await persistence.database.connect();
    try {
      await client.query('BEGIN');

      const ratingRes: QueryResult<ClipRating> = await client.query(
        `INSERT INTO public."clip_rating" (clip_id, user_id, score, is_skipped)
         VALUES ($1::uuid, $2::uuid, $3, $4)
         ON CONFLICT (clip_id, user_id) DO UPDATE SET
           score = EXCLUDED.score,
           is_skipped = EXCLUDED.is_skipped,
           updated_at = NOW()
         RETURNING ${ratingCols()}`,
        [clipId, userId, input.skipped ? null : input.score, input.skipped]
      );
      const rating = ratingRes.rows[0];

      // Award-Stimmen idempotent neu setzen.
      await client.query(`DELETE FROM public."clip_rating_award" WHERE rating_id = $1::uuid`, [rating.id]);
      for (const awardId of validAwardIds) {
        await client.query(
          `INSERT INTO public."clip_rating_award" (rating_id, award_id)
           VALUES ($1::uuid, $2::uuid)
           ON CONFLICT DO NOTHING`,
          [rating.id, awardId]
        );
      }

      await client.query('COMMIT');
      return rating;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Eigene Bewertung eines Clips inkl. vergebener Award-IDs (für Detail-Ansicht). */
  async getUserRating(userId: string, clipId: string): Promise<(ClipRating & { awardIds: string[] }) | null> {
    const ratingRes: QueryResult<ClipRating> = await persistence.database.query(
      `SELECT ${ratingCols()} FROM public."clip_rating" WHERE user_id = $1::uuid AND clip_id = $2::uuid`,
      [userId, clipId]
    );
    const rating = ratingRes.rows[0];
    if (!rating) return null;

    const awardRes: QueryResult<{ award_id: string }> = await persistence.database.query(
      `SELECT award_id FROM public."clip_rating_award" WHERE rating_id = $1::uuid`,
      [rating.id]
    );
    return { ...rating, awardIds: awardRes.rows.map((r) => r.award_id) };
  }

  /** Anzahl abgegebener Bewertungen (inkl. Skips) — für Profil/Statistik. */
  async countByUser(userId: string): Promise<number> {
    const result: QueryResult<{ count: number }> = await persistence.database.query(
      `SELECT COUNT(*)::int AS count FROM public."clip_rating" WHERE user_id = $1::uuid`,
      [userId]
    );
    return result.rows[0]?.count ?? 0;
  }
}

export default new ClipRatingService();
