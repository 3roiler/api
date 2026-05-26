/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Streamclips: URL-Slug-Spalte auf `clip`.
 *
 * Hintergrund: bisher sind Clip-URLs UUIDs (`/streamclips/clip/<uuid>`) —
 * für Google ein Long-Tail-SEO-Verlust, weil die URL keine Keywords trägt.
 * Mit dieser Migration bekommt jeder Clip einen aus dem Titel abgeleiteten
 * Slug. Die kanonische URL wird `/streamclips/clip/<slug>-<shortid>`
 * (slug + erste 8 UUID-Hex-Zeichen als Disambiguator), siehe Frontend-/
 * OG-Routen. Backwards-Compat: die alte UUID-Form redirected (siehe
 * og.ts + Caddyfile).
 *
 * Der Slug ist KEIN UNIQUE-Constraint — Disambig macht die shortid, nicht
 * der Slug. So vermeidet die Migration Dedupe-Logik und neue Submissions
 * kollidieren nicht, wenn zwei Twitch-Clips identisch betitelt sind.
 *
 * Slugify-Regeln (matchen `slugifyTitle()` im Frontend / clip-Service):
 *   - lowercase
 *   - ä/ö/ü/ß → ae/oe/ue/ss
 *   - akzentuierte Vokale → Basisbuchstabe
 *   - alles andere Nicht-[a-z0-9] → `-`
 *   - mehrere `-` zusammenfassen, von vorn/hinten trimmen
 *   - auf 100 Zeichen kürzen
 *   - leerer Slug → `'clip'` (Fallback)
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    // 1. Spalte nullable hinzufügen — Bestandsdaten müssen erst gebackfilled
    //    werden, bevor `NOT NULL` greifen kann.
    pgm.addColumn('clip', {
        slug: { type: 'varchar(120)' }
    });

    // 2. pg_temp-Funktion + Backfill. `pg_temp` ist Session-lokal und wird
    //    automatisch verworfen, sobald die Migrations-Session endet —
    //    keine permanente DB-Pollution.
    pgm.sql(`
        CREATE OR REPLACE FUNCTION pg_temp.slugify_de(input text)
        RETURNS varchar(120) AS $$
        DECLARE
            s text;
        BEGIN
            s := lower(coalesce(input, ''));
            s := regexp_replace(s, 'ä', 'ae', 'g');
            s := regexp_replace(s, 'ö', 'oe', 'g');
            s := regexp_replace(s, 'ü', 'ue', 'g');
            s := regexp_replace(s, 'ß', 'ss', 'g');
            s := regexp_replace(s, '[éèêë]', 'e', 'g');
            s := regexp_replace(s, '[áàâãå]', 'a', 'g');
            s := regexp_replace(s, '[óòôõø]', 'o', 'g');
            s := regexp_replace(s, '[úùûü]', 'u', 'g');
            s := regexp_replace(s, '[íìîï]', 'i', 'g');
            s := regexp_replace(s, 'ç', 'c', 'g');
            s := regexp_replace(s, 'ñ', 'n', 'g');
            s := regexp_replace(s, '[^a-z0-9]+', '-', 'g');
            s := trim(BOTH '-' FROM s);
            s := left(s, 100);
            IF s = '' THEN
                RETURN 'clip';
            END IF;
            RETURN s::varchar(120);
        END;
        $$ LANGUAGE plpgsql IMMUTABLE;

        UPDATE public."clip" SET slug = pg_temp.slugify_de(title) WHERE slug IS NULL;
    `);

    // 3. Jetzt darf die Spalte NOT NULL werden — alle Bestandszeilen
    //    haben einen Wert.
    pgm.alterColumn('clip', 'slug', { notNull: true });

    // 4. Index — gebraucht für die Sitemap-Generation (Slug-Lookup
    //    pro Clip beim Bau der Sitemap-Einträge) und für ein optionales
    //    "Slug aus URL stimmt mit DB überein"-Check beim Detail-Aufruf.
    //    Nicht UNIQUE — die Eindeutigkeit kommt aus der shortid.
    pgm.createIndex('clip', 'slug', { name: 'clip_slug_idx' });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.dropIndex('clip', 'slug', { name: 'clip_slug_idx' });
    pgm.dropColumn('clip', 'slug');
};
