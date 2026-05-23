/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Drei zusammenhängende Schema-Änderungen:
 *
 *  1. User-Anonymisierung: `user.deleted_at` als Soft-Delete-Marker.
 *     Der Datenschutz-„Nuke"-Knopf wird vom Hard-Delete auf
 *     Anonymisierung umgestellt — alle PII (E-Mail, Name, Avatar,
 *     externe-IDs) wird beim Löschen genullt/auf Platzhalter gesetzt,
 *     die Zeile selbst bleibt aber bestehen, damit Foreign Keys aus
 *     Clips/Kommentaren/Reports nicht ins Leere zeigen.
 *
 *  2. Generic `comment` Tabelle (polymorph, mit Threading):
 *     - Ersetzt `clip_comment`. Daten werden 1:1 übernommen.
 *     - `parent_comment_id` ermöglicht beliebig tiefe Sub-Threads
 *       (Frontend gibt einen sinnvollen Cap — meistens reicht 1 Level).
 *     - `target_type` + `target_id` als Polymorphie-Anker. CHECK
 *       hält die Liste klein, momentan nur 'clip' und 'blog_post'.
 *     - `deletion_reason` für Moderator-Soft-Deletes (mit Begründung).
 *
 *  3. `comment_mute` Tabelle: Eintrag pro User der vom Kommentieren
 *     ausgeschlossen ist. Optional zeitlich begrenzt
 *     (`muted_until` NULL = unbefristet).
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    // ─── 1) user.deleted_at ────────────────────────────────────────────
    pgm.addColumns('user', {
        deleted_at: { type: 'timestamptz' }
    });
    // Partial-Index für die häufige Filter-Bedingung „aktive User".
    pgm.createIndex('user', 'deleted_at', {
        name: 'idx_user_deleted_at',
        where: 'deleted_at IS NOT NULL'
    });

    // ─── 2) Generic comment + Datenmigration aus clip_comment ──────────
    pgm.createTable('comment', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        // Selbst-Referenz für Threading. ON DELETE CASCADE: löscht ein
        // Moderator den Parent (Soft- oder Hard-, hier unwahrscheinlich),
        // hängen die Replies an einem ghost — der CASCADE räumt sie auf.
        // Wir machen die Replies erreichbar so lange der Parent „existiert",
        // also auch wenn er nur soft-deleted ist.
        parent_comment_id: {
            type: 'uuid',
            references: '"comment"(id)',
            onDelete: 'CASCADE'
        },
        // Polymorpher Anker. Wir verzichten bewusst auf eine FK
        // (sonst bräuchten wir Trigger pro target_type) — Konsistenz
        // wird in der Service-Schicht erzwungen.
        target_type: {
            type: 'varchar(20)',
            notNull: true,
            check: "target_type IN ('clip', 'blog_post')"
        },
        target_id: { type: 'uuid', notNull: true },
        user_id: {
            type: 'uuid',
            notNull: true,
            references: '"user"(id)',
            onDelete: 'RESTRICT' // wir hard-deleten User nicht mehr; siehe (1)
        },
        body: { type: 'varchar(2000)', notNull: true },
        // Nur für target_type='clip' relevant. Bei 'blog_post' immer NULL.
        timestamp_seconds: { type: 'float8' },
        // Soft-Delete-Marker. Author und Moderator können soft-deleten.
        deleted_at: { type: 'timestamptz' },
        deleted_by_user_id: {
            type: 'uuid',
            references: '"user"(id)',
            onDelete: 'SET NULL'
        },
        // Optional: bei Moderator-Delete wird hier der Grund hinterlegt
        // und im Frontend transparent als „gelöscht von Moderator
        // (Grund: X)" angezeigt. Self-Delete lässt das NULL.
        deletion_reason: { type: 'text' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamptz' }
    });

    pgm.addConstraint('comment', 'comment_timestamp_nonneg', {
        check: 'timestamp_seconds IS NULL OR timestamp_seconds >= 0'
    });
    pgm.addConstraint('comment', 'comment_blog_no_timestamp', {
        check: "target_type <> 'blog_post' OR timestamp_seconds IS NULL"
    });

    // Hauptindex für die Liste pro Target — chronologisch absteigend.
    pgm.createIndex('comment', ['target_type', 'target_id', 'created_at'], {
        name: 'idx_comment_target_created'
    });
    // Threading: alle Replies eines Kommentars.
    pgm.createIndex('comment', ['parent_comment_id', 'created_at'], {
        name: 'idx_comment_parent_created',
        where: 'parent_comment_id IS NOT NULL'
    });
    // „Meine Kommentare"-Profil später.
    pgm.createIndex('comment', ['user_id', 'created_at'], {
        name: 'idx_comment_user_created'
    });

    // Daten aus clip_comment übernehmen. Wir setzen target_type='clip'
    // und mappen clip_id → target_id. parent_comment_id und
    // deletion_reason bleiben NULL (gab's vorher nicht).
    pgm.sql(`
        INSERT INTO public."comment"
            (id, parent_comment_id, target_type, target_id, user_id, body,
             timestamp_seconds, deleted_at, deleted_by_user_id, deletion_reason,
             created_at, updated_at)
        SELECT
            id, NULL, 'clip', clip_id, user_id, body,
            timestamp_seconds, deleted_at, deleted_by_user_id, NULL,
            created_at, updated_at
        FROM public."clip_comment"
    `);

    pgm.dropTable('clip_comment');

    // ─── 3) comment_mute ───────────────────────────────────────────────
    pgm.createTable('comment_mute', {
        user_id: {
            type: 'uuid',
            primaryKey: true,
            references: '"user"(id)',
            onDelete: 'CASCADE'
        },
        reason: { type: 'text', notNull: true },
        muted_by_user_id: {
            type: 'uuid',
            notNull: true,
            references: '"user"(id)',
            onDelete: 'RESTRICT'
        },
        // NULL = unbefristet. Ein User kann sich also nicht selbst „unmuten",
        // aber ein Moderator setzt einen `muted_until`-Wert für temporäre
        // Sanktionen.
        muted_until: { type: 'timestamptz' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') }
    });
    pgm.createIndex('comment_mute', 'muted_until', {
        name: 'idx_comment_mute_until',
        where: 'muted_until IS NOT NULL'
    });
};

/**
 * Down-Migration: zurück zum Pre-038-Schema. Nur sinnvoll falls wir
 * nichts gepostet haben — sub-thread Replies können nicht zurück in
 * eine flache `clip_comment` Tabelle, also droppen wir sie.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.dropTable('comment_mute');

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
    pgm.createIndex('clip_comment', ['clip_id', 'created_at'], { name: 'idx_clip_comment_clip_created' });
    pgm.createIndex('clip_comment', ['user_id', 'created_at'], { name: 'idx_clip_comment_user_created' });
    pgm.addConstraint('clip_comment', 'clip_comment_timestamp_nonneg', {
        check: 'timestamp_seconds IS NULL OR timestamp_seconds >= 0'
    });

    // Nur Top-Level-Kommentare zurück migrieren (Replies können nicht
    // dargestellt werden in einer flachen Tabelle).
    pgm.sql(`
        INSERT INTO public."clip_comment"
            (id, clip_id, user_id, body, timestamp_seconds,
             deleted_at, deleted_by_user_id, created_at, updated_at)
        SELECT
            id, target_id, user_id, body, timestamp_seconds,
            deleted_at, deleted_by_user_id, created_at, updated_at
        FROM public."comment"
        WHERE target_type = 'clip' AND parent_comment_id IS NULL
    `);

    pgm.dropTable('comment');
    pgm.dropIndex('user', 'deleted_at', { name: 'idx_user_deleted_at' });
    pgm.dropColumns('user', ['deleted_at']);
};
