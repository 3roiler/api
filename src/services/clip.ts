import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import AppError from './error.js';
import twitchClip, { parseClipId } from './twitch-clip.js';
import awardCategory from './award-category.js';
import settings from './settings.js';
import { readForYouSettings } from './foryou-settings.js';
import type {
  Clip,
  ClipAwardTally,
  ClipSection,
  ClipStatus,
  ClipWithContext
} from '../models/index.js';

/**
 * URL-Slugify analog zur Migration `040_clip_slugs.js` (`pg_temp.slugify_de`).
 * Wichtig: muss beim DB-Backfill und bei neuen Submissions dasselbe
 * Ergebnis produzieren, sonst sehen alte Clips „falsche" Slugs.
 *
 * - lowercase
 * - deutsche Umlaute → ae/oe/ue/ss
 * - akzentuierte Vokale → Basisbuchstabe (für Twitch-Titel, die oft
 *   internationale Streamer-Namen enthalten)
 * - alles Nicht-[a-z0-9] → `-`
 * - mehrere `-` zusammenfassen, von vorn/hinten trimmen
 * - auf 100 Zeichen kürzen
 * - leer → 'clip' (Fallback)
 */
export function slugifyTitle(title: string | null | undefined): string {
  let s = (title ?? '').toLowerCase();
  s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  s = s.replace(/[éèêë]/g, 'e');
  s = s.replace(/[áàâãå]/g, 'a');
  s = s.replace(/[óòôõø]/g, 'o');
  s = s.replace(/[úùûü]/g, 'u');
  s = s.replace(/[íìîï]/g, 'i');
  s = s.replace(/ç/g, 'c').replace(/ñ/g, 'n');
  s = s.replace(/[^a-z0-9]+/g, '-');
  // Leading/trailing dashes ohne Regex trimmen. Anchored quantifier
  // wäre linear, aber Sonar S5852 flaggt `/^-+/` und `/-+$/` trotzdem
  // konservativ als super-linear — die Index-Walk-Variante ist
  // semantisch identisch, linear, und Analyzer-stumm.
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === 45 /* '-' */) start++;
  let end = s.length;
  while (end > start && s.charCodeAt(end - 1) === 45) end--;
  s = s.slice(start, end);
  s = s.slice(0, 100);
  return s || 'clip';
}

/**
 * Die "shortid" einer Clip-URL — die ersten 8 Hex-Zeichen der UUID
 * (Bindestriche entfernt). Disambiguator in `/streamclips/clip/<slug>-<shortid>`
 * und Lookup-Key in `getByShortid`. 8 Hex-Zeichen = 16^8 ≈ 4 Mrd Werte;
 * Geburtstagsparadoxon-Kollision wird bei ~65k Einträgen nennenswert
 * — weit jenseits dessen, was Streamclips erreichen wird.
 */
export function shortidFromId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toLowerCase();
}

/** Eine Browse-Reihe ("Laufband") gruppiert nach Twitch-Kategorie. */
export interface BrowseCategoryRow {
  gameId: string;
  name: string;
  section: ClipSection | null;
  clips: ClipWithContext[];
}

/** Eine Browse-Reihe gruppiert nach Award-Label. */
export interface BrowseAwardRow {
  key: string;
  displayName: string;
  emoji: string | null;
  color: string | null;
  clips: ClipWithContext[];
}

/**
 * Clip-Service — Einreichen, Zufalls-Feed, Detail, Moderation, Leaderboard.
 *
 * `numeric`-Spalten (duration_seconds, AVG(score)) liefert node-pg als
 * String — daher überall `::float8` casten, damit das Frontend echte
 * Zahlen bekommt. COUNT(...) wird zu `::int` gecastet (sonst bigint→string).
 *
 * Award-Zählungen werden NICHT in der Hauptquery aggregiert (das würde
 * fan-out × GROUP BY erzwingen), sondern per `attachAwards` in einer
 * zweiten Batch-Query nachgeladen.
 */
function clipCols(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  return `
    ${p}id,
    ${p}twitch_clip_id AS "twitchClipId",
    ${p}submitted_by_user_id AS "submittedByUserId",
    ${p}title,
    ${p}slug,
    ${p}broadcaster_id AS "broadcasterId",
    ${p}broadcaster_name AS "broadcasterName",
    ${p}creator_name AS "creatorName",
    ${p}game_id AS "gameId",
    ${p}thumbnail_url AS "thumbnailUrl",
    ${p}embed_url AS "embedUrl",
    ${p}video_url AS "videoUrl",
    ${p}duration_seconds::float8 AS "durationSeconds",
    ${p}view_count AS "viewCount",
    ${p}language,
    ${p}clip_created_at AS "clipCreatedAt",
    ${p}status,
    ${p}rejection_reason AS "rejectionReason",
    ${p}created_at AS "createdAt",
    ${p}updated_at AS "updatedAt"
  `;
}

const CLIP_CTX_FROM = `
  FROM public."clip" c
  JOIN public."user" u ON u.id = c.submitted_by_user_id
  LEFT JOIN public."twitch_category" tc ON tc.id = c.game_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE r.score IS NOT NULL) AS rating_count,
           AVG(r.score) FILTER (WHERE r.score IS NOT NULL) AS avg_score
    FROM public."clip_rating" r WHERE r.clip_id = c.id
  ) agg ON true
`;

const CLIP_CTX_SELECT = `
  SELECT ${clipCols('c')},
    u.name AS "submitterName",
    u.display_name AS "submitterDisplayName",
    u.avatar_url AS "submitterAvatarUrl",
    tc.name AS "categoryName",
    tc.section AS "section",
    COALESCE(agg.rating_count, 0)::int AS "ratingCount",
    agg.avg_score::float8 AS "avgScore"
  ${CLIP_CTX_FROM}
`;

type ClipCtxRow = Omit<ClipWithContext, 'awards'>;

export interface LeaderboardOptions {
  section?: string;
  /** Nur Clips, die in den letzten N Tagen eingereicht wurden. Undefined = Allzeit. */
  periodDays?: number;
  limit?: number;
}

export class ClipService {
  /**
   * Einreichen: URL/Slug parsen → Dedup → Twitch-Metadaten holen →
   * Kategorie auflösen → Status bestimmen (Auto-Freigabe vs. Prüfung)
   * → Clip anlegen.
   */
  async submit(userId: string, input: string): Promise<Clip> {
    const slug = parseClipId(input);
    if (!slug) {
      throw AppError.badRequest('Keine gültige Twitch-Clip-URL oder -ID.', 'BAD_CLIP_URL');
    }

    const existing = await this.getByTwitchClipId(slug);
    if (existing) {
      throw AppError.conflict('Dieser Clip wurde bereits eingereicht.', 'CLIP_DUPLICATE');
    }

    const meta = await twitchClip.fetchClipMeta(slug);
    if (!meta) {
      throw AppError.notFound('Twitch kennt diesen Clip nicht.', 'CLIP_NOT_FOUND');
    }

    // Kategorie auflösen. ensureCategory liefert die Sektion zurück (oder
    // null, wenn die Kategorie nicht auflösbar ist) — der Clip bleibt dann
    // kategorielos statt unspeicherbar (FK).
    const section = meta.gameId ? await this.ensureCategory(meta.gameId) : null;
    const gameId = section !== null ? meta.gameId : null;

    const status = await this.determineSubmitStatus(userId, section);

    // URL-Slug aus dem Twitch-Titel — landet in `/streamclips/clip/<slug>-<shortid>`.
    // Eindeutigkeit kommt aus der shortid (= UUID-Prefix), daher KEIN
    // Dedupe-Suffix nötig. Helfer matched `pg_temp.slugify_de` aus der
    // Migration 040_clip_slugs.
    const urlSlug = slugifyTitle(meta.title);

    const result: QueryResult<Clip> = await persistence.database.query(
      `INSERT INTO public."clip"
         (twitch_clip_id, submitted_by_user_id, title, slug, broadcaster_id, broadcaster_name,
          creator_name, game_id, status, thumbnail_url, embed_url, video_url, duration_seconds,
          view_count, language, clip_created_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING ${clipCols()}`,
      [
        slug, userId, meta.title, urlSlug, meta.broadcasterId, meta.broadcasterName, meta.creatorName,
        gameId, status, meta.thumbnailUrl, meta.embedUrl, meta.url, meta.duration, meta.viewCount,
        meta.language, meta.createdAt || null
      ]
    );
    return result.rows[0];
  }

  /**
   * Status eines neu eingereichten Clips:
   *   1. globaler "alles prüfen"-Toggle      → pending
   *   2. Clip-Sektion ist review-pflichtig    → pending
   *   3. Tageslimit erreicht (≥ N heute frei) → pending
   *   4. sonst                                → approved
   * Alle Werte sind über app_setting (Dashboard) konfigurierbar.
   */
  private async determineSubmitStatus(userId: string, section: string | null): Promise<ClipStatus> {
    if (await settings.getSettingValue('clips.require_review_all', false)) {
      return 'pending';
    }
    const reviewSections = await settings.getSettingValue<string[]>('clips.review_sections', []);
    if (section && Array.isArray(reviewSections) && reviewSections.includes(section)) {
      return 'pending';
    }
    const limit = await settings.getSettingValue('clips.auto_approve_daily_limit', 5);
    const approvedToday = await this.countApprovedToday(userId);
    return approvedToday < limit ? 'approved' : 'pending';
  }

  /** Anzahl heute (UTC-Tag) freigegebener Clips dieses Nutzers. */
  private async countApprovedToday(userId: string): Promise<number> {
    const result = await persistence.database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM public."clip"
       WHERE submitted_by_user_id = $1::uuid
         AND status = 'approved'
         AND created_at >= date_trunc('day', now())`,
      [userId]
    );
    return result.rows[0]?.count ?? 0;
  }

  /**
   * Stellt sicher, dass die Twitch-Kategorie in `twitch_category` liegt.
   * Gibt die Sektion zurück (neue Kategorien starten auf 'other'), oder
   * null, wenn die Kategorie nicht auflösbar ist.
   */
  private async ensureCategory(gameId: string): Promise<string | null> {
    const existing = await persistence.database.query<{ section: string }>(
      `SELECT section FROM public."twitch_category" WHERE id = $1`,
      [gameId]
    );
    if ((existing.rowCount ?? 0) > 0) return existing.rows[0].section;

    const cat = await twitchClip.fetchCategory(gameId);
    if (!cat) return null;

    await persistence.database.query(
      `INSERT INTO public."twitch_category" (id, name, box_art_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [cat.id, cat.name, cat.boxArtUrl]
    );
    return 'other';
  }

  async getByTwitchClipId(slug: string): Promise<Clip | null> {
    const result: QueryResult<Clip> = await persistence.database.query(
      `SELECT ${clipCols()} FROM public."clip" WHERE twitch_clip_id = $1`,
      [slug]
    );
    return result.rows[0] ?? null;
  }

  async getById(id: string): Promise<ClipWithContext | null> {
    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT} WHERE c.id = $1::uuid`,
      [id]
    );
    const rows = this.withAwardsStub(result.rows);
    if (rows.length === 0) return null;
    await this.attachAwards(rows);
    return rows[0];
  }

  /**
   * Weitere freigegebene Clips desselben Broadcasters — für das
   * „Mehr von diesem Streamer"-Karussell auf der Clip-Detailseite.
   * `excludeId` blendet den gerade angezeigten Clip aus; ohne den Filter
   * würde der User sich selbst empfohlen bekommen.
   */
  async listByBroadcaster(
    broadcasterId: string,
    opts: { excludeId?: string; limit?: number } = {}
  ): Promise<ClipWithContext[]> {
    const limit = Math.min(opts.limit ?? 8, 24);
    const params: unknown[] = [broadcasterId];
    let excludeClause = '';
    if (opts.excludeId) {
      params.push(opts.excludeId);
      excludeClause = `AND c.id <> $${params.length}::uuid`;
    }
    params.push(limit);
    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.status = 'approved'
         AND c.broadcaster_id = $1
         ${excludeClause}
       ORDER BY COALESCE(agg.avg_score, 0) DESC NULLS LAST, agg.rating_count DESC, c.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    const rows = this.withAwardsStub(result.rows);
    await this.attachAwards(rows);
    return rows;
  }

  /**
   * Hub-Page „Streamer": alle freigegebenen Clips eines Broadcasters,
   * gefunden über `broadcaster_name` (case-insensitive — die URL ist
   * `/streamclips/streamer/<lowercased-name>`). Twitch-Login-Namen sind
   * ASCII-only `[a-zA-Z0-9_]`, daher keine Slug-Transformation nötig.
   *
   * Liefert auch den Display-Namen (das erste Vorkommen) und die
   * `broadcaster_id` zurück, damit die Hub-Page einen passenden Header
   * rendern kann ohne einen separaten Twitch-Helix-Call.
   */
  async listByBroadcasterName(
    name: string,
    limit = 50
  ): Promise<{
    broadcasterId: string | null;
    broadcasterName: string;
    clips: ClipWithContext[];
  } | null> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.status = 'approved'
         AND lower(c.broadcaster_name) = lower($1)
       ORDER BY COALESCE(agg.avg_score, 0) DESC NULLS LAST, agg.rating_count DESC, c.created_at DESC
       LIMIT $2`,
      [name, safeLimit]
    );
    if (result.rows.length === 0) return null;
    const rows = this.withAwardsStub(result.rows);
    await this.attachAwards(rows);
    const first = rows[0];
    return {
      broadcasterId: first.broadcasterId,
      broadcasterName: first.broadcasterName ?? name,
      clips: rows
    };
  }

  /**
   * Hub-Page „Kategorie": alle freigegebenen Clips einer Twitch-Kategorie,
   * gefunden über den Slug des `twitch_category.name`. Match-Logik nutzt
   * `pg_temp.slugify_de` aus der Migration `040_clip_slugs` — Funktion
   * existiert dort nur Session-lokal, deshalb hier inline als `WITH`-CTE.
   * Die Kategorien-Tabelle ist klein (Twitch hat einige Tausend, aber
   * broiler.dev cached nur die tatsächlich vergebenen) — sequentielle
   * Slugify reicht.
   */
  async listByCategorySlug(
    slug: string,
    limit = 50
  ): Promise<{
    category: { id: string; name: string; section: ClipSection | null; slug: string };
    clips: ClipWithContext[];
  } | null> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    // Slug ist URL-Parameter; die JS-Variante des Helpers passt zur
    // pg-Variante in Migration 040 — beide normalisieren ä/ö/ü/ß und
    // Akzente identisch. Wir suchen also schlicht über lowercase-name
    // mit Postgres-side slugify in einer CTE.
    const matchRes = await persistence.database.query<{
      id: string;
      name: string;
      section: ClipSection | null;
    }>(
      `WITH normalized AS (
         SELECT id, name, section,
                regexp_replace(
                  regexp_replace(
                    regexp_replace(
                      regexp_replace(
                        regexp_replace(
                          regexp_replace(
                            regexp_replace(
                              regexp_replace(lower(name), 'ä', 'ae', 'g'),
                              'ö', 'oe', 'g'),
                            'ü', 'ue', 'g'),
                          'ß', 'ss', 'g'),
                        '[éèêë]', 'e', 'g'),
                      '[áàâãå]', 'a', 'g'),
                    '[óòôõø]', 'o', 'g'),
                  '[^a-z0-9]+', '-', 'g') AS raw_slug
         FROM public."twitch_category"
       )
       SELECT id, name, section
       FROM normalized
       WHERE trim(BOTH '-' FROM raw_slug) = $1
       LIMIT 1`,
      [slug]
    );
    const category = matchRes.rows[0];
    if (!category) return null;

    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.status = 'approved' AND c.game_id = $1
       ORDER BY COALESCE(agg.avg_score, 0) DESC NULLS LAST, agg.rating_count DESC, c.created_at DESC
       LIMIT $2`,
      [category.id, safeLimit]
    );
    const rows = this.withAwardsStub(result.rows);
    await this.attachAwards(rows);
    return {
      category: { ...category, slug },
      clips: rows
    };
  }

  /**
   * Hub-Page „Award": alle freigegebenen Clips, die mit dem gegebenen
   * Award (über `award_category.key`) ausgezeichnet wurden. Sortiert
   * nach Anzahl der Award-Stimmen für genau diesen Award DESC, danach
   * Gesamt-Score. Award-Key ist bereits Slug-Form (`'funniest'`, …).
   */
  async listByAwardKey(
    key: string,
    limit = 50
  ): Promise<{
    award: { id: string; key: string; displayName: string; emoji: string | null; color: string | null };
    clips: ClipWithContext[];
  } | null> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const awardRes = await persistence.database.query<{
      id: string;
      key: string;
      displayName: string;
      emoji: string | null;
      color: string | null;
    }>(
      `SELECT id, key, display_name AS "displayName", emoji, color
       FROM public."award_category"
       WHERE key = $1 AND is_active = true`,
      [key]
    );
    const award = awardRes.rows[0];
    if (!award) return null;

    const result: QueryResult<ClipCtxRow & { awardVotes: number }> = await persistence.database.query(
      `SELECT ${clipCols('c')},
         u.name AS "submitterName",
         u.display_name AS "submitterDisplayName",
         u.avatar_url AS "submitterAvatarUrl",
         tc.name AS "categoryName",
         tc.section AS "section",
         COALESCE(agg.rating_count, 0)::int AS "ratingCount",
         agg.avg_score::float8 AS "avgScore",
         award_agg.votes::int AS "awardVotes"
       FROM public."clip" c
       JOIN public."user" u ON u.id = c.submitted_by_user_id
       LEFT JOIN public."twitch_category" tc ON tc.id = c.game_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE r.score IS NOT NULL) AS rating_count,
                AVG(r.score) FILTER (WHERE r.score IS NOT NULL) AS avg_score
         FROM public."clip_rating" r WHERE r.clip_id = c.id
       ) agg ON true
       JOIN LATERAL (
         SELECT COUNT(*)::int AS votes
         FROM public."clip_rating" r
         JOIN public."clip_rating_award" ra ON ra.rating_id = r.id
         WHERE r.clip_id = c.id AND ra.award_id = $1::uuid
       ) award_agg ON award_agg.votes > 0
       WHERE c.status = 'approved'
       ORDER BY award_agg.votes DESC, COALESCE(agg.avg_score, 0) DESC NULLS LAST, c.created_at DESC
       LIMIT $2`,
      [award.id, safeLimit]
    );
    const rows = this.withAwardsStub(result.rows);
    await this.attachAwards(rows);
    return { award, clips: rows };
  }

  /**
   * Distinct broadcasters mit ≥1 freigegebenem Clip — für die Sitemap-
   * Erweiterung um Streamer-Hub-URLs. `updatedAt` ist das jüngste Update
   * eines Clips, damit die Hub-Page ein sinnvolles `lastmod` bekommt.
   */
  async listSitemapBroadcasters(): Promise<
    { broadcasterName: string; updatedAt: Date | null }[]
  > {
    const result = await persistence.database.query<{
      broadcasterName: string;
      updatedAt: Date | null;
    }>(
      `SELECT broadcaster_name AS "broadcasterName",
              MAX(COALESCE(updated_at, created_at)) AS "updatedAt"
       FROM public."clip"
       WHERE status = 'approved' AND broadcaster_name IS NOT NULL
       GROUP BY broadcaster_name
       ORDER BY broadcaster_name`
    );
    return result.rows;
  }

  /** Twitch-Kategorien mit ≥1 freigegebenem Clip — Sitemap-Hub-Listing. */
  async listSitemapCategories(): Promise<
    { name: string; updatedAt: Date | null }[]
  > {
    const result = await persistence.database.query<{
      name: string;
      updatedAt: Date | null;
    }>(
      `SELECT tc.name AS "name",
              MAX(COALESCE(c.updated_at, c.created_at)) AS "updatedAt"
       FROM public."twitch_category" tc
       JOIN public."clip" c ON c.game_id = tc.id
       WHERE c.status = 'approved'
       GROUP BY tc.name
       ORDER BY tc.name`
    );
    return result.rows;
  }

  /** Aktive Awards mit ≥1 Stimme auf einem freigegebenen Clip. */
  async listSitemapAwards(): Promise<
    { key: string; updatedAt: Date | null }[]
  > {
    const result = await persistence.database.query<{ key: string; updatedAt: Date | null }>(
      `SELECT ac.key,
              MAX(COALESCE(c.updated_at, c.created_at)) AS "updatedAt"
       FROM public."award_category" ac
       JOIN public."clip_rating_award" ra ON ra.award_id = ac.id
       JOIN public."clip_rating" r ON r.id = ra.rating_id
       JOIN public."clip" c ON c.id = r.clip_id
       WHERE ac.is_active = true AND c.status = 'approved'
       GROUP BY ac.key
       ORDER BY ac.key`
    );
    return result.rows;
  }

  /**
   * Personalisierter „Für dich"-Feed (v2).
   *
   * Im Kern ein simples scoring-Modell mit drei Signalen, mehr braucht's
   * für den aktuellen Datenbestand nicht. Pro Clip wird ein Score
   * berechnet:
   *
   *     score = matching_signal * 0.55      // mag der User die Kategorie?
   *           + bayesian_quality * 0.30     // wie gut ist der Clip global?
   *           + recency_boost * 0.15        // wie frisch ist der Clip?
   *
   * - `matching_signal`: 1.0 wenn der Clip in einer der drei meistbewer-
   *   teten Kategorien des Users liegt, 0.5 in einer weiteren Top-6,
   *   0.0 sonst.
   * - `bayesian_quality`: avg_score, Bayesian gegen die globale Median-
   *   Bewertung gedämpft (gleiche Formel wie der Leaderboard).
   * - `recency_boost`: 1.0 für < 3 Tage, linear runter auf 0.0 bei
   *   30 Tagen — neue Clips bekommen also einen kleinen Push, damit sie
   *   nicht in einem von alten Top-Clips zugemüllten Feed verschwinden.
   *
   * Wir exkludieren weiterhin Clips, die der User selbst eingereicht
   * oder bereits bewertet hat. Cold-Start (keine Ratings vom User):
   * fällt auf das 30-Tage-Leaderboard zurück — mit demselben Recency-
   * Boost, damit auch dort frische Einreichungen sichtbar bleiben.
   *
   * Bewusst keine Vector-Embeddings, keine Collab-Filter — die liefern
   * unter ~10k Ratings nur Rauschen. Diese Variante ist eine Query und
   * der User kann nachvollziehen, warum ein Clip im Feed steht.
   */
  async listPersonalFeed(userId: string, limit = 12): Promise<ClipWithContext[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 36);
    const M = 5; // Mindeststimmen-Gewicht für die Bayesian-Dämpfung
    const cfg = await readForYouSettings();

    // Globaler Score-Durchschnitt — nur einmal pro Aufruf.
    const avgRes: QueryResult<{ avg: number | null }> = await persistence.database.query(
      `SELECT AVG(score)::float8 AS avg FROM public."clip_rating" WHERE score IS NOT NULL`
    );
    const globalAvg = avgRes.rows[0]?.avg ?? 0;

    // User-Kategorie-Präferenzen — Top 6, ordered nach (count, avg).
    const catRes: QueryResult<{ gameId: string }> = await persistence.database.query(
      `SELECT c.game_id AS "gameId"
       FROM public."clip_rating" r
       JOIN public."clip" c ON c.id = r.clip_id
       WHERE r.user_id = $1::uuid
         AND r.score IS NOT NULL
         AND r.score >= $2
         AND c.game_id IS NOT NULL
       GROUP BY c.game_id
       ORDER BY COUNT(*) DESC, AVG(r.score) DESC
       LIMIT 6`,
      [userId, cfg.minPositiveScore]
    );
    const gameIds = catRes.rows.map((row) => row.gameId).filter(Boolean);
    const primaryIds = gameIds.slice(0, 3);
    const secondaryIds = gameIds.slice(3);

    // Cold-Start: User hat keine ≥-MinScore-Bewertungen. Top-Clips der
    // konfigurierten Recency-Fenstergröße mit konstantem Boost, sonst
    // sähe die Empfehlung wie ein jahrealtes „best of"-Album aus.
    if (gameIds.length === 0) {
      const result: QueryResult<ClipCtxRow> = await persistence.database.query(
        `${CLIP_CTX_SELECT}
         WHERE c.status = 'approved'
           AND c.created_at >= NOW() - make_interval(days => $5::int)
           AND c.submitted_by_user_id <> $1::uuid
         ORDER BY (
             COALESCE(agg.rating_count, 0)::float8
               / (COALESCE(agg.rating_count, 0) + $2)
           ) * COALESCE(agg.avg_score, 0)
           + ($2::float8 / (COALESCE(agg.rating_count, 0) + $2)) * $3
           + GREATEST(
               0,
               1.0 - EXTRACT(EPOCH FROM (NOW() - c.created_at)) / ($5::float8 * 86400)
             ) * 1.5
           DESC
         LIMIT $4::int`,
        [userId, M, globalAvg, safeLimit, cfg.recencyWindowDays]
      );
      const rows = this.withAwardsStub(result.rows);
      if (rows.length > 0) {
        await this.attachAwards(rows);
        return rows;
      }
      return this.leaderboard({ limit: safeLimit });
    }

    // Personalisiertes Scoring mit den eingestellten Gewichten und dem
    // konfigurierten Frische-Pool (zusätzliches OR im WHERE).
    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.status = 'approved'
         AND c.submitted_by_user_id <> $1::uuid
         AND NOT EXISTS (
           SELECT 1 FROM public."clip_rating" r
           WHERE r.clip_id = c.id AND r.user_id = $1::uuid
         )
         AND (
           c.game_id = ANY($2::text[])
           OR c.game_id = ANY($3::text[])
           OR c.created_at >= NOW() - make_interval(days => $9::int)
         )
       ORDER BY (
           CASE
             WHEN c.game_id = ANY($2::text[]) THEN 1.0
             WHEN c.game_id = ANY($3::text[]) THEN 0.5
             ELSE 0.0
           END
         ) * $6
         + (
             (COALESCE(agg.rating_count, 0)::float8
               / (COALESCE(agg.rating_count, 0) + $4))
             * COALESCE(agg.avg_score, 0)
             + ($4::float8 / (COALESCE(agg.rating_count, 0) + $4)) * $5
           ) / 5.0 * $7
         + GREATEST(
             0,
             1.0 - EXTRACT(EPOCH FROM (NOW() - c.created_at)) / ($10::float8 * 86400)
           ) * $8
         DESC,
         agg.rating_count DESC NULLS LAST
       LIMIT $11::int`,
      [
        userId,
        primaryIds,
        secondaryIds,
        M,
        globalAvg,
        cfg.weightMatching,
        cfg.weightQuality,
        cfg.weightRecency,
        cfg.freshnessPoolDays,
        cfg.recencyWindowDays,
        safeLimit
      ]
    );
    const rows = this.withAwardsStub(result.rows);
    if (rows.length === 0) {
      return this.leaderboard({ limit: safeLimit, periodDays: cfg.recencyWindowDays });
    }
    await this.attachAwards(rows);
    return rows;
  }

  /**
   * Top-Einreicher („Hall of Fame"). Liefert User mit aggregierten
   * Metriken über ihre approved Clips: Anzahl, durchschnittlicher
   * Score, beliebtester Clip-Titel. Sortiert nach einem zusammen-
   * gesetzten Score (avg_score × log(count)).
   *
   * Bewusst nur approved Clips — Submissions in der Pipeline würden
   * sonst die Tabelle volatilen Kennzahlen aussetzen, je nachdem
   * ob ein Mod gerade durchwirkt.
   */
  async listTopContributors(
    limit = 25
  ): Promise<{
    userId: string;
    name: string;
    displayName: string | null;
    avatarUrl: string | null;
    clipCount: number;
    avgScore: number | null;
    topClipId: string | null;
    topClipSlug: string | null;
    topClipTitle: string | null;
  }[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const result = await persistence.database.query(
      `WITH user_clips AS (
         SELECT c.submitted_by_user_id AS user_id,
                COUNT(*)::int AS clip_count,
                AVG(agg.avg_score) FILTER (WHERE agg.rating_count > 0)::float8 AS avg_score
         FROM public."clip" c
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE r.score IS NOT NULL) AS rating_count,
                  AVG(r.score) FILTER (WHERE r.score IS NOT NULL) AS avg_score
           FROM public."clip_rating" r WHERE r.clip_id = c.id
         ) agg ON true
         WHERE c.status = 'approved'
         GROUP BY c.submitted_by_user_id
       ),
       top_clips AS (
         SELECT DISTINCT ON (c.submitted_by_user_id)
           c.submitted_by_user_id AS user_id,
           c.id AS clip_id,
           c.slug AS clip_slug,
           c.title AS clip_title
         FROM public."clip" c
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE r.score IS NOT NULL) AS rating_count,
                  AVG(r.score) FILTER (WHERE r.score IS NOT NULL) AS avg_score
           FROM public."clip_rating" r WHERE r.clip_id = c.id
         ) agg ON true
         WHERE c.status = 'approved'
         ORDER BY c.submitted_by_user_id,
                  COALESCE(agg.avg_score, 0) DESC NULLS LAST,
                  agg.rating_count DESC NULLS LAST,
                  c.created_at DESC
       )
       SELECT
         u.id AS "userId",
         u.name AS "name",
         u.display_name AS "displayName",
         u.avatar_url AS "avatarUrl",
         uc.clip_count AS "clipCount",
         uc.avg_score AS "avgScore",
         tc.clip_id AS "topClipId",
         tc.clip_slug AS "topClipSlug",
         tc.clip_title AS "topClipTitle"
       FROM user_clips uc
       JOIN public."user" u ON u.id = uc.user_id
       LEFT JOIN top_clips tc ON tc.user_id = uc.user_id
       ORDER BY COALESCE(uc.avg_score, 0) * LN(uc.clip_count + 1) DESC,
                uc.clip_count DESC
       LIMIT $1`,
      [safeLimit]
    );
    return result.rows;
  }

  /** Alle freigegebenen Clips (id + updated_at) für die dynamische Sitemap. */
  async listApprovedForSitemap(): Promise<
    { id: string; slug: string; updatedAt: Date | null }[]
  > {
    const result: QueryResult<{ id: string; slug: string; updatedAt: Date | null }> =
      await persistence.database.query(
        `SELECT id, slug, updated_at AS "updatedAt"
         FROM public."clip" WHERE status = 'approved'
         ORDER BY created_at DESC`
      );
    return result.rows;
  }

  /**
   * Lookup über die URL-shortid (= erste 8 Hex-Zeichen der UUID,
   * Bindestriche entfernt). Treibt das Auflösen von
   * `/streamclips/clip/<slug>-<shortid>`: das Slug-Stück ist rein
   * dekorativ, die shortid liefert den eindeutigen Clip.
   *
   * Bei Kollision (sehr unwahrscheinlich, siehe `shortidFromId` Doc)
   * gewinnt der älteste Clip — deterministisch und stabil. Indexnutzung:
   * Postgres kann den b-tree-Index auf `id` für `LIKE 'prefix%'`
   * verwenden, wenn das UUID-Format konsistent ist; wir casten daher
   * zu text und LIKE auf den UUID-String (ohne Bindestriche zu fummeln,
   * weil das die index-Nutzung kaputtmachen würde).
   */
  async getByShortid(shortid: string): Promise<ClipWithContext | null> {
    if (!/^[0-9a-f]{8}$/i.test(shortid)) return null;
    // UUID-Standardformat: ersten 8 Zeichen + `-`. Wir matchen also auf
    // `id::text LIKE '<8hex>-%'` — bleibt index-tauglich.
    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.id::text LIKE $1
       ORDER BY c.created_at ASC
       LIMIT 1`,
      [`${shortid.toLowerCase()}-%`]
    );
    const rows = this.withAwardsStub(result.rows);
    if (rows.length === 0) return null;
    await this.attachAwards(rows);
    return rows[0];
  }

  /**
   * Zufälliger, noch nicht bewerteter, freigegebener Clip — der
   * Kern-Loop. Eigene Clips sind ausgeschlossen (Self-Vote-Sperre).
   *
   * `ORDER BY random()` ist bei sehr großen Tabellen teuer; für den
   * erwarteten Datenbestand ausreichend. Optimierung (TABLESAMPLE /
   * Keyset über eine Zufallsspalte) bei Bedarf in Phase 2.
   */
  async getFeedNext(userId: string, opts: { section?: string } = {}): Promise<ClipWithContext | null> {
    const params: unknown[] = [userId];
    let sectionClause = '';
    if (opts.section) {
      params.push(opts.section);
      sectionClause = `AND tc.section = $${params.length}`;
    }

    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.status = 'approved'
         AND c.submitted_by_user_id <> $1::uuid
         AND NOT EXISTS (
           SELECT 1 FROM public."clip_rating" r2
           WHERE r2.clip_id = c.id AND r2.user_id = $1::uuid
         )
         ${sectionClause}
       ORDER BY random()
       LIMIT 1`,
      params
    );
    const rows = this.withAwardsStub(result.rows);
    if (rows.length === 0) return null;
    await this.attachAwards(rows);
    return rows[0];
  }

  async listMine(userId: string, limit = 50, offset = 0): Promise<ClipWithContext[]> {
    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.submitted_by_user_id = $1::uuid
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, Math.min(limit, 100), Math.max(offset, 0)]
    );
    const rows = this.withAwardsStub(result.rows);
    await this.attachAwards(rows);
    return rows;
  }

  async listForModeration(
    status: ClipStatus | ClipStatus[] = 'pending',
    limit = 50,
    offset = 0
  ): Promise<ClipWithContext[]> {
    const statuses = Array.isArray(status) ? status : [status];
    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.status = ANY($1::varchar[])
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [statuses, Math.min(limit, 100), Math.max(offset, 0)]
    );
    const rows = this.withAwardsStub(result.rows);
    await this.attachAwards(rows);
    return rows;
  }

  async setStatus(id: string, status: ClipStatus, rejectionReason?: string | null): Promise<Clip> {
    const result: QueryResult<Clip> = await persistence.database.query(
      `UPDATE public."clip"
       SET status = $2, rejection_reason = $3, updated_at = NOW()
       WHERE id = $1::uuid
       RETURNING ${clipCols()}`,
      [id, status, rejectionReason ?? null]
    );
    if (!result.rows[0]) throw AppError.notFound('Clip nicht gefunden.', 'CLIP_NOT_FOUND');
    return result.rows[0];
  }

  /**
   * Top-Clips per Bayesian-Average — gewichtet einen kleinen Stimmen-
   * Stand gegen den globalen Durchschnitt, damit ein einzelnes 5★ nicht
   * gegen viele 4,8★ gewinnt. Phase 1: global + optionaler Sektions-
   * Filter. Award-Scope und Zeiträume folgen in Phase 2.
   */
  async leaderboard(opts: LeaderboardOptions = {}): Promise<ClipWithContext[]> {
    const limit = Math.min(opts.limit ?? 20, 100);
    const M = 5; // Mindeststimmen-Gewicht

    const avgRes: QueryResult<{ avg: number | null }> = await persistence.database.query(
      `SELECT AVG(score)::float8 AS avg FROM public."clip_rating" WHERE score IS NOT NULL`
    );
    const globalAvg = avgRes.rows[0]?.avg ?? 0;

    const params: unknown[] = [M, globalAvg];
    let sectionClause = '';
    if (opts.section) {
      params.push(opts.section);
      sectionClause = `AND tc.section = $${params.length}`;
    }
    let periodClause = '';
    if (opts.periodDays && opts.periodDays > 0) {
      params.push(opts.periodDays);
      periodClause = `AND c.created_at >= NOW() - make_interval(days => $${params.length}::int)`;
    }
    params.push(limit);
    const limitParam = params.length;

    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.status = 'approved' ${sectionClause} ${periodClause}
       ORDER BY (
         (COALESCE(agg.rating_count, 0)::float8 / (COALESCE(agg.rating_count, 0) + $1))
           * COALESCE(agg.avg_score, 0)
         + ($1::float8 / (COALESCE(agg.rating_count, 0) + $1)) * $2
       ) DESC,
       COALESCE(agg.rating_count, 0) DESC
       LIMIT $${limitParam}`,
      params
    );
    const rows = this.withAwardsStub(result.rows);
    await this.attachAwards(rows);
    return rows;
  }

  /** Neueste freigegebene Clips inkl. Kontext + Award-Tallies. */
  async listApproved(limit = 300): Promise<ClipWithContext[]> {
    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.status = 'approved'
       ORDER BY c.created_at DESC
       LIMIT $1`,
      [Math.min(limit, 500)]
    );
    const rows = this.withAwardsStub(result.rows);
    await this.attachAwards(rows);
    return rows;
  }

  /**
   * Browse-Daten für die Streamclips-Startseite: dieselben freigegebenen
   * Clips zweimal gruppiert — nach Twitch-Kategorie (Achse A) und nach
   * Award-Label (Achse B). Ein DB-Load, danach in-memory gruppiert; für
   * den erwarteten Datenbestand ausreichend.
   */
  async browse(perRow = 15): Promise<{ byCategory: BrowseCategoryRow[]; byAward: BrowseAwardRow[] }> {
    const clips = await this.listApproved(300);

    const catMap = new Map<string, BrowseCategoryRow>();
    for (const c of clips) {
      if (!c.gameId) continue;
      let row = catMap.get(c.gameId);
      if (!row) {
        row = { gameId: c.gameId, name: c.categoryName ?? c.gameId, section: c.section, clips: [] };
        catMap.set(c.gameId, row);
      }
      if (row.clips.length < perRow) row.clips.push(c);
    }

    const awards = await awardCategory.listActive();
    const byAward: BrowseAwardRow[] = [];
    for (const a of awards) {
      const matching = clips
        .filter((c) => c.awards.some((t) => t.key === a.key))
        .sort(
          (x, y) =>
            (y.awards.find((t) => t.key === a.key)?.count ?? 0) -
            (x.awards.find((t) => t.key === a.key)?.count ?? 0)
        )
        .slice(0, perRow);
      if (matching.length > 0) {
        byAward.push({ key: a.key, displayName: a.displayName, emoji: a.emoji, color: a.color, clips: matching });
      }
    }

    return { byCategory: [...catMap.values()], byAward };
  }

  /**
   * Volltextsuche über freigegebene Clips: Titel, Broadcaster, Clip-
   * Ersteller, Einreicher (name/display_name), Twitch-Kategorie und
   * vergebene Award-Labels. ILIKE-basiert mit escapeten Wildcards.
   */
  async search(q: string, limit = 50): Promise<ClipWithContext[]> {
    const trimmed = (q ?? '').trim();
    if (trimmed.length < 2) return [];
    const pattern = `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

    const result: QueryResult<ClipCtxRow> = await persistence.database.query(
      `${CLIP_CTX_SELECT}
       WHERE c.status = 'approved' AND (
         c.title ILIKE $1 ESCAPE '\\' OR
         c.broadcaster_name ILIKE $1 ESCAPE '\\' OR
         c.creator_name ILIKE $1 ESCAPE '\\' OR
         u.name ILIKE $1 ESCAPE '\\' OR
         u.display_name ILIKE $1 ESCAPE '\\' OR
         tc.name ILIKE $1 ESCAPE '\\' OR
         EXISTS (
           SELECT 1
           FROM public."clip_rating" r
           JOIN public."clip_rating_award" cra ON cra.rating_id = r.id
           JOIN public."award_category" ac ON ac.id = cra.award_id
           WHERE r.clip_id = c.id
             AND (ac.display_name ILIKE $1 ESCAPE '\\' OR ac.key ILIKE $1 ESCAPE '\\')
         )
       )
       ORDER BY c.created_at DESC
       LIMIT $2`,
      [pattern, Math.min(limit, 100)]
    );
    const rows = this.withAwardsStub(result.rows);
    await this.attachAwards(rows);
    return rows;
  }

  /** Initialisiert das (noch leere) awards-Feld, damit der Typ stimmt. */
  private withAwardsStub(rows: ClipCtxRow[]): ClipWithContext[] {
    return rows.map((r) => ({ ...r, awards: [] as ClipAwardTally[] }));
  }

  /** Lädt Award-Zählungen für mehrere Clips in einer Query nach. */
  private async attachAwards(clips: ClipWithContext[]): Promise<void> {
    if (clips.length === 0) return;
    const ids = clips.map((c) => c.id);
    const result: QueryResult<ClipAwardTally & { clipId: string }> = await persistence.database.query(
      `SELECT r.clip_id AS "clipId",
              ac.key,
              ac.display_name AS "displayName",
              ac.emoji,
              ac.color,
              COUNT(*)::int AS count
       FROM public."clip_rating_award" cra
       JOIN public."clip_rating" r ON r.id = cra.rating_id
       JOIN public."award_category" ac ON ac.id = cra.award_id
       WHERE r.clip_id = ANY($1::uuid[])
       GROUP BY r.clip_id, ac.key, ac.display_name, ac.emoji, ac.color, ac.sort_order
       ORDER BY ac.sort_order ASC`,
      [ids]
    );

    const byClip = new Map<string, ClipAwardTally[]>();
    for (const row of result.rows) {
      const { clipId, ...tally } = row;
      const list = byClip.get(clipId) ?? [];
      list.push(tally);
      byClip.set(clipId, list);
    }
    for (const clip of clips) {
      clip.awards = byClip.get(clip.id) ?? [];
    }
  }
}

export default new ClipService();
