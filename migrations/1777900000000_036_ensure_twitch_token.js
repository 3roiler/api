/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Repariert eine Prod-DB-Inkonsistenz: `002_twitch` war in der
 * pgmigrations-Tabelle als ausgeführt markiert, aber `twitch_token`
 * existierte dort physisch nicht (Twitch-Login → 42P01 in
 * saveTwitchToken). `user.twitch_id` war hingegen vorhanden.
 *
 * Beide Objekte werden hier idempotent (IF NOT EXISTS) sichergestellt:
 * Prod wird repariert, und überall sonst (wo 002 sauber lief) ist es
 * ein No-op. Struktur identisch zu `002_twitch`.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.addColumn('user', {
        twitch_id: { type: 'varchar(255)', unique: true }
    }, { ifNotExists: true });

    pgm.createTable('twitch_token', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        user_id: {
            type: 'uuid',
            notNull: true,
            unique: true,
            references: 'user',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        twitch_user_id: { type: 'varchar(255)', notNull: true },
        twitch_login: { type: 'varchar(255)', notNull: true },
        access_token: { type: 'text', notNull: true },
        refresh_token: { type: 'text', notNull: true },
        scopes: { type: 'text', notNull: true, default: '' },
        expires_at: { type: 'timestamptz', notNull: true },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true },
        updated_at: { type: 'timestamptz' }
    }, { ifNotExists: true });
};

/**
 * Bewusst leer: Diese Migration stellt nur Objekte aus `002_twitch`
 * wieder her. Ein Drop würde die eigentliche 002-Tabelle entfernen.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = () => {
    // no-op
};
