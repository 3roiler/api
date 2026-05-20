import { Request, Response, NextFunction } from 'express';
import { awardCategory as awardCategoryService } from '../services/index.js';
import type { ClipSection } from '../models/index.js';

/**
 * Öffentliche Kategorie-Endpunkte für die Filter-/Vote-UI.
 *
 * Sektionen (Achse A) sind eine feste Liste — die DB-seitige Zuordnung
 * `twitch_category.section` mappt auf genau diese Keys. Hier nur die
 * Anzeige-Labels (deutsch).
 */
const SECTIONS: ReadonlyArray<{ key: ClipSection; label: string }> = [
  { key: 'gaming', label: 'Gaming' },
  { key: 'just_chatting', label: 'Just Chatting' },
  { key: 'irl', label: 'IRL' },
  { key: 'music', label: 'Musik' },
  { key: 'esports', label: 'Esports' },
  { key: 'creative', label: 'Kreativ' },
  { key: 'other', label: 'Sonstiges' }
];

/** GET /api/categories/awards — aktive Award-Kategorien (Achse B). */
const listAwards = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const awards = await awardCategoryService.listActive();
    return res.status(200).json(awards);
  } catch (err) {
    return next(err);
  }
};

/** GET /api/categories/sections — feste Sektions-Liste (Achse A). */
const listSections = async (_req: Request, res: Response, _next: NextFunction) => {
  return res.status(200).json(SECTIONS);
};

export default { listAwards, listSections };
