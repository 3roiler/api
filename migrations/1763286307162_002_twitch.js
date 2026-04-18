/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
    pgm.addColumn('user', {
        twitch_id: { type: 'varchar(255)', unique: true }
    });

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
    });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.dropTable('twitch_token');
    pgm.dropColumn('user', 'twitch_id');
};
