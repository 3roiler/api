import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import AppError from './error.js';
import type { AwardCategory } from '../models/index.js';

/**
 * Award-Kategorien (Achse B) — die "lustigster / bester Play / …"-Labels.
 * Öffentlich nur die aktiven; das Dashboard verwaltet alle.
 */
const AWARD_COLUMNS = `
  id,
  key,
  display_name AS "displayName",
  description,
  emoji,
  color,
  is_active AS "isActive",
  sort_order AS "sortOrder",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export interface CreateAwardOptions {
  key: string;
  displayName: string;
  description?: string | null;
  emoji?: string | null;
  color?: string | null;
  sortOrder?: number;
}

export interface UpdateAwardOptions {
  displayName?: string;
  description?: string | null;
  emoji?: string | null;
  color?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export class AwardCategoryService {
  async listActive(): Promise<AwardCategory[]> {
    const result: QueryResult<AwardCategory> = await persistence.database.query(
      `SELECT ${AWARD_COLUMNS} FROM public."award_category"
       WHERE is_active = true
       ORDER BY sort_order ASC, display_name ASC`
    );
    return result.rows;
  }

  async listAll(): Promise<AwardCategory[]> {
    const result: QueryResult<AwardCategory> = await persistence.database.query(
      `SELECT ${AWARD_COLUMNS} FROM public."award_category"
       ORDER BY sort_order ASC, display_name ASC`
    );
    return result.rows;
  }

  async getById(id: string): Promise<AwardCategory | null> {
    const result: QueryResult<AwardCategory> = await persistence.database.query(
      `SELECT ${AWARD_COLUMNS} FROM public."award_category" WHERE id = $1::uuid`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Reduziert eine Liste von Award-IDs auf die, die existieren UND aktiv
   * sind. Schützt das Voting davor, Stimmen auf inaktive/fremde IDs zu
   * schreiben — der Controller leitet diese Liste direkt aus dem
   * Request-Body ab.
   */
  async filterValidActiveIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const result: QueryResult<{ id: string }> = await persistence.database.query(
      `SELECT id FROM public."award_category"
       WHERE is_active = true AND id = ANY($1::uuid[])`,
      [ids]
    );
    return result.rows.map((r) => r.id);
  }

  async create(opts: CreateAwardOptions): Promise<AwardCategory> {
    try {
      const result: QueryResult<AwardCategory> = await persistence.database.query(
        `INSERT INTO public."award_category" (key, display_name, description, emoji, color, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${AWARD_COLUMNS}`,
        [opts.key, opts.displayName, opts.description ?? null, opts.emoji ?? null, opts.color ?? null, opts.sortOrder ?? 0]
      );
      return result.rows[0];
    } catch (err) {
      // 23505 = unique_violation auf `key`.
      if ((err as { code?: string }).code === '23505') {
        throw AppError.conflict(`Award-Key "${opts.key}" existiert bereits.`, 'AWARD_KEY_DUPLICATE');
      }
      throw err;
    }
  }

  async update(id: string, opts: UpdateAwardOptions): Promise<AwardCategory> {
    const fields: Array<[string, unknown]> = [
      ['display_name', opts.displayName],
      ['description', opts.description],
      ['emoji', opts.emoji],
      ['color', opts.color],
      ['is_active', opts.isActive],
      ['sort_order', opts.sortOrder]
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [col, val] of fields) {
      if (val !== undefined) {
        values.push(val);
        sets.push(`${col} = $${values.length}`);
      }
    }
    if (sets.length === 0) {
      const current = await this.getById(id);
      if (!current) throw AppError.notFound('Award-Kategorie nicht gefunden.', 'AWARD_NOT_FOUND');
      return current;
    }
    sets.push('updated_at = NOW()');
    values.push(id);
    const result: QueryResult<AwardCategory> = await persistence.database.query(
      `UPDATE public."award_category" SET ${sets.join(', ')}
       WHERE id = $${values.length}::uuid
       RETURNING ${AWARD_COLUMNS}`,
      values
    );
    if (!result.rows[0]) throw AppError.notFound('Award-Kategorie nicht gefunden.', 'AWARD_NOT_FOUND');
    return result.rows[0];
  }

  async remove(id: string): Promise<boolean> {
    const result = await persistence.database.query(
      `DELETE FROM public."award_category" WHERE id = $1::uuid`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export default new AwardCategoryService();
