/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Streamclips Germany — Twitch-Clip-Bewertungsplattform.
 *
 * Zwei getrennte Klassifizierungs-Achsen (siehe Konzept):
 *   A) objektiv  — `twitch_category` (Twitch game_id) gruppiert über
 *      `section` zu Gaming / Just Chatting / IRL / …
 *   B) subjektiv — `award_category` ("lustigster", "bester Play", …),
 *      die Nutzer beim Voten vergeben.
 *
 * Bewertungs-Mechanik: ein Nutzer bewertet einen Clip genau einmal
 * (`UNIQUE(clip_id, user_id)`). Eine Bewertung ist entweder ein Score
 * 1–5 ODER ein Skip/Enthalten (`is_skipped`) — nie beides. Geskippte
 * Clips bekommen so trotzdem eine Zeile und tauchen im Zufalls-Feed
 * nicht erneut auf.
 *
 * Permissions (in permissions.ts + bootstrap.ts): `clips.submit`
 * (einreichen), `clips.moderate` (freigeben/ablehnen, Awards/Sektionen
 * pflegen, Reports), `dashboard.clips` (Dashboard-Sektion). Bewerten
 * selbst braucht nur Login.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    // ─── Achse A: Twitch-Kategorie → Sektion ────────────────────────────
    // PK ist die Twitch game_id (varchar) selbst — wir cachen Twitchs
    // Kategorie-Stammdaten und hängen unsere Sektions-Zuordnung dran.
    pgm.createTable('twitch_category', {
        id: { type: 'varchar(255)', primaryKey: true }, // Twitch game_id
        name: { type: 'varchar(255)', notNull: true },
        box_art_url: { type: 'text' },
        // Macro-Gruppierung über die Twitch-Kategorie. Default 'other',
        // der Admin ordnet im Dashboard zu. CHECK hält die Liste
        // synchron mit ClipSection im Frontend/Backend.
        section: {
            type: 'varchar(20)',
            notNull: true,
            default: 'other',
            check: "section IN ('gaming','just_chatting','irl','music','esports','creative','other')"
        },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamptz' }
    });

    // ─── Achse B: Award-Kategorien ──────────────────────────────────────
    pgm.createTable('award_category', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        // Stabiler Slug für Frontend/Filter, unabhängig vom Anzeigenamen.
        key: {
            type: 'varchar(40)',
            notNull: true,
            unique: true,
            check: "key ~ '^[a-z][a-z0-9_]{1,38}[a-z0-9]$'"
        },
        display_name: { type: 'varchar(80)', notNull: true },
        description: { type: 'text' },
        emoji: { type: 'varchar(16)' },
        // Tailwind-Akzent (z.B. 'amber','emerald') — UI-seitig auf eine
        // Whitelist gemappt, hier nur als String gespeichert.
        color: { type: 'varchar(24)' },
        is_active: { type: 'boolean', notNull: true, default: true },
        sort_order: { type: 'integer', notNull: true, default: 0 },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamptz' }
    });

    // ─── Clips ──────────────────────────────────────────────────────────
    pgm.createTable('clip', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        // Twitchs Clip-Slug/-ID. UNIQUE => Deduplizierung beim Einreichen.
        twitch_clip_id: { type: 'varchar(255)', notNull: true, unique: true },
        submitted_by_user_id: {
            type: 'uuid',
            notNull: true,
            references: 'user',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        // Helix-Metadaten (Snapshot bei Einreichung).
        title: { type: 'varchar(255)', notNull: true },
        broadcaster_id: { type: 'varchar(255)' },
        broadcaster_name: { type: 'varchar(255)' },
        creator_name: { type: 'varchar(255)' },
        // Twitch game_id. SET NULL: löscht der Admin eine Kategorie,
        // soll der Clip nicht mitverschwinden. Nullable, weil die
        // Helix-Kategorie-Abfrage beim Einreichen fehlschlagen darf.
        game_id: {
            type: 'varchar(255)',
            references: 'twitch_category',
            onDelete: 'SET NULL'
        },
        thumbnail_url: { type: 'text' },
        embed_url: { type: 'text' },
        video_url: { type: 'text' },
        duration_seconds: { type: 'numeric(6,2)' },
        view_count: { type: 'integer', notNull: true, default: 0 },
        // Twitch-Sprachcode (z.B. 'de'). Treibt den "Germany"-Filter.
        language: { type: 'varchar(10)' },
        clip_created_at: { type: 'timestamptz' },
        // Moderation: nur 'approved' erscheint im Vote-Feed.
        status: {
            type: 'varchar(20)',
            notNull: true,
            default: 'pending',
            check: "status IN ('pending','approved','rejected','flagged')"
        },
        rejection_reason: { type: 'text' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamptz' }
    });

    // Mod-Queue (status-scoped, neueste zuerst) und Sektions-Ranking.
    pgm.createIndex('clip', ['status', { name: 'created_at', sort: 'DESC' }], { name: 'clip_status_idx' });
    pgm.createIndex('clip', 'game_id', { name: 'clip_game_idx' });
    pgm.createIndex('clip', 'submitted_by_user_id', { name: 'clip_submitter_idx' });

    // ─── Bewertungen ────────────────────────────────────────────────────
    pgm.createTable('clip_rating', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        clip_id: {
            type: 'uuid',
            notNull: true,
            references: 'clip',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        user_id: {
            type: 'uuid',
            notNull: true,
            references: 'user',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        score: { type: 'smallint', check: 'score BETWEEN 1 AND 5' },
        is_skipped: { type: 'boolean', notNull: true, default: false },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamptz' }
    });

    // Ein Nutzer bewertet einen Clip genau einmal.
    pgm.addConstraint('clip_rating', 'clip_rating_unique_per_user', {
        unique: ['clip_id', 'user_id']
    });

    // Entweder Score (Bewertung) ODER Skip (Enthaltung) — nie beides,
    // nie keines. Das macht die "noch nicht bewertet"-Abfrage eindeutig.
    pgm.sql(`
      ALTER TABLE public."clip_rating"
      ADD CONSTRAINT clip_rating_score_xor_skip
      CHECK (
        (is_skipped = true  AND score IS NULL) OR
        (is_skipped = false AND score IS NOT NULL)
      );
    `);

    // Hot path: "welche Clips hat dieser User schon gesehen/bewertet?"
    pgm.createIndex('clip_rating', ['user_id', 'clip_id'], { name: 'clip_rating_user_idx' });
    pgm.createIndex('clip_rating', 'clip_id', { name: 'clip_rating_clip_idx' });

    // ─── Award-Stimmen (m:n an einer Bewertung) ─────────────────────────
    pgm.createTable('clip_rating_award', {
        rating_id: {
            type: 'uuid',
            notNull: true,
            references: 'clip_rating',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        award_id: {
            type: 'uuid',
            notNull: true,
            references: 'award_category',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        }
    });
    pgm.addConstraint('clip_rating_award', 'clip_rating_award_pkey', {
        primaryKey: ['rating_id', 'award_id']
    });
    // Award-Leaderboard zählt über award_id.
    pgm.createIndex('clip_rating_award', 'award_id', { name: 'clip_rating_award_award_idx' });

    // ─── Meldungen ──────────────────────────────────────────────────────
    pgm.createTable('clip_report', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        clip_id: {
            type: 'uuid',
            notNull: true,
            references: 'clip',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        reporter_user_id: {
            type: 'uuid',
            notNull: true,
            references: 'user',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        reason: { type: 'varchar(500)', notNull: true },
        status: {
            type: 'varchar(20)',
            notNull: true,
            default: 'open',
            check: "status IN ('open','resolved','dismissed')"
        },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        resolved_at: { type: 'timestamptz' },
        resolved_by: { type: 'uuid', references: 'user', onDelete: 'SET NULL' }
    });
    pgm.createIndex('clip_report', ['status', { name: 'created_at', sort: 'DESC' }], { name: 'clip_report_status_idx' });

    // ─── Seed: Standard-Award-Kategorien ────────────────────────────────
    pgm.sql(`
      INSERT INTO public."award_category" (key, display_name, description, emoji, color, sort_order) VALUES
        ('funniest',  'Lustigster Clip', 'Zum Wegschmeißen komisch.',            '😂', 'amber',   10),
        ('best_play', 'Bester Play',     'Mechanisch oder strategisch stark.',   '🎯', 'emerald', 20),
        ('clutch',    'Clutch',          'Im letzten Moment gedreht.',           '🔥', 'orange',  30),
        ('fail',      'Fail des Tages',  'Schiefgegangen — und das ist gut so.', '💀', 'red',     40),
        ('wholesome', 'Wholesome',       'Herzerwärmend, positiv, wholesome.',   '🥰', 'pink',    50),
        ('wtf',       'WTF',             'Einfach… was?',                        '🤯', 'purple',  60);
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.dropTable('clip_report');
    pgm.dropTable('clip_rating_award');
    pgm.dropTable('clip_rating');
    pgm.dropTable('clip');
    pgm.dropTable('award_category');
    pgm.dropTable('twitch_category');
};
