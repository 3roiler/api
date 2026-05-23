/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Kommentare auf Clips, optional mit Zeitstempel im Clip.
 *
 * Ein Kommentar hängt an einem Clip (FK) und einem User (FK). `body`
 * ist Plaintext (max 2000 Zeichen) — wir rendern keinen Markdown,
 * damit XSS-Vektoren wegfallen.
 *
 * `timestamp_seconds` ist optional. Wenn gesetzt, kann das Frontend
 * den Twitch-Embed an dieser Position starten. Bewusst Sekunden als
 * float8 (Twitch-Player nutzt float-precision Sekunden bei `time=`).
 *
 * `deleted_at` für Soft-Delete: Moderatoren können einen Kommentar
 * entfernen, ohne dass die Permalinks darunter brechen. Frontend
 * filtert standardmäßig `WHERE deleted_at IS NULL`.
 *
 * Indices:
 *  - `(clip_id, created_at DESC)` für das schnelle Laden der
 *    Kommentar-Liste auf der Clip-Detailseite (chronologisch absteigend).
 *  - `(user_id, created_at DESC)` für „meine Kommentare"-Views
 *    (Profil-Page, später).
 *
 * Permissions (in permissions.ts, separat ergänzt):
 *  - `clips.comment` — Kommentar schreiben/löschen (eigene)
 *  - `clips.moderate` — fremde Kommentare löschen (Soft-Delete)
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.createTable('clip_comment', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        clip_id: {
            type: 'uuid',
            notNull: true,
            references: '"clip"(id)',
            onDelete: 'CASCADE'
        },
        user_id: {
            type: 'uuid',
            notNull: true,
            references: '"user"(id)',
            onDelete: 'CASCADE'
        },
        body: { type: 'varchar(2000)', notNull: true },
        // NULL = Kommentar ohne Zeitbezug („Allgemein"). float8 weil
        // der Twitch-Embed-Player `?time=` mit Float-Sekunden akzeptiert.
        timestamp_seconds: { type: 'float8' },
        deleted_at: { type: 'timestamptz' },
        deleted_by_user_id: {
            type: 'uuid',
            references: '"user"(id)',
            onDelete: 'SET NULL'
        },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamptz' }
    });

    pgm.createIndex('clip_comment', ['clip_id', 'created_at'], {
        name: 'idx_clip_comment_clip_created',
        method: 'btree'
    });
    pgm.createIndex('clip_comment', ['user_id', 'created_at'], {
        name: 'idx_clip_comment_user_created',
        method: 'btree'
    });

    // Sanity-Constraint: Timestamp darf nicht negativ sein. Wir
    // verzichten auf eine harte Obergrenze, weil wir nicht jedes
    // Update der `clip.duration_seconds` durch eine DB-Validierung
    // jagen wollen — das Frontend clamped beim Lesen.
    pgm.addConstraint('clip_comment', 'clip_comment_timestamp_nonneg', {
        check: 'timestamp_seconds IS NULL OR timestamp_seconds >= 0'
    });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.dropTable('clip_comment');
};
