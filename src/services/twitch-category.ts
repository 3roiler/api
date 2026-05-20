import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import AppError from './error.js';
import type { TwitchCategory, ClipSection } from '../models/index.js';

/**
 * Verwaltung der gecachten Twitch-Kategorien und ihrer Sektions-Zuordnung
 * (Achse A). Kategorien selbst entstehen automatisch beim Clip-Einreichen
 * (siehe clip.ensureCategory); hier werden sie nur gelistet und ihrer
 * Sektion (gaming/just_chatting/…) zugeordnet.
 */
const CATEGORY_COLUMNS = `
  id,
  name,
  box_art_url AS "boxArtUrl",
  section,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const VALID_SECTIONS: ClipSection[] = [
  'gaming', 'just_chatting', 'irl', 'music', 'esports', 'creative', 'other'
];

export interface TwitchCategoryWithCount extends TwitchCategory {
  /** Anzahl Clips (egal welcher Status) in dieser Kategorie. */
  clipCount: number;
}

export class TwitchCategoryService {
  /** Alle Kategorien inkl. Clip-Anzahl, alphabetisch — für die Mapping-UI. */
  async listAll(): Promise<TwitchCategoryWithCount[]> {
    const result: QueryResult<TwitchCategoryWithCount> = await persistence.database.query(
      `SELECT ${CATEGORY_COLUMNS},
              (SELECT COUNT(*)::int FROM public."clip" c WHERE c.game_id = tc.id) AS "clipCount"
       FROM public."twitch_category" tc
       ORDER BY tc.name ASC`
    );
    return result.rows;
  }

  async setSection(id: string, section: ClipSection): Promise<TwitchCategory> {
    if (!VALID_SECTIONS.includes(section)) {
      throw AppError.badRequest(`Ungültige Sektion. Erlaubt: ${VALID_SECTIONS.join(', ')}.`, 'BAD_SECTION');
    }
    const result: QueryResult<TwitchCategory> = await persistence.database.query(
      `UPDATE public."twitch_category"
       SET section = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING ${CATEGORY_COLUMNS}`,
      [id, section]
    );
    if (!result.rows[0]) throw AppError.notFound('Kategorie nicht gefunden.', 'CATEGORY_NOT_FOUND');
    return result.rows[0];
  }
}

export default new TwitchCategoryService();
