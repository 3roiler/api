/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
    pgm.createExtension('pgcrypto', { ifNotExists: true });

    pgm.createDomain('token_hash', 'text', {
        constraints: [
            'CHECK (VALUE ~ \'^[a-f0-9]{64}$\')'
        ]
    });

    pgm.createFunction(
        'generate_token_hash',
        [],
        {
            returns: 'token_hash',
            language: 'plpgsql'
        },
        `
    DECLARE
        token TEXT := encode(gen_random_bytes(48), 'hex');
        token_hash TEXT;
    BEGIN
        token_hash := encode(digest(token, 'sha256'), 'hex');
        RETURN token_hash;
    END;
    `
    );

    pgm.createTable('user', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        github_ref: { type: 'text', unique: true, notNull: true },
        name: { type: 'varchar(40)', notNull: true, match: '^[a-z0-9][a-z0-9.-]{2,38}[a-z0-9]$/i' },
        display_name: { type: 'varchar(100)', match: '^[a-z0-9][a-z0-9.-]{2,98}[a-z0-9]$/i' },
        email: { type: 'varchar(254)', match: '/[a-z0-9._%+-]+@[a-z0-9-]+.+.[a-z]{2,4}/igm' },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true },
        updated_at: { type: 'timestamptz' }
    });

    pgm.createTable('group', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        based_on: { type: 'uuid', references: 'group', onDelete: 'SET NULL' },
        key: { type: 'varchar(40)', notNull: true, unique: true, match: '^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/i' },
        display_name: { type: 'varchar(100)', notNull: true, match: '^[a-z0-9][a-z0-9.-]{2,98}[a-z0-9]$/i' },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true },
        updated_at: { type: 'timestamptz' }
    });

    pgm.createTable('user_group', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        user_id: {
            type: 'uuid',
            notNull: true,
            references: 'user',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        group_id: {
            type: 'uuid',
            notNull: true,
            references: 'group',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        assigned_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });

    pgm.createTable('user_permission', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        user_id: {
            type: 'uuid',
            notNull: true,
            references: 'user',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        permission: { type: 'text', notNull: true },
        granted_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });

    pgm.createTable('group_permission', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        group_id: {
            type: 'uuid',
            notNull: true,
            references: 'group',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        permission: { type: 'text', notNull: true },
        granted_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    }); 

    pgm.createTable('refresh_token', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        user_id: {
            type: 'uuid',
            notNull: true,
            references: 'user',
            onDelete: 'CASCADE'
        },
        provider: { type: 'text', notNull: true },
        hash: { type: 'token_hash', default: pgm.func('generate_token_hash()'), notNull: true },
        expires_at: { type: 'timestamptz', notNull: true },
        agent: { type: 'text' },
        ip_address: { type: 'text' },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true },
        revoked_at: { type: 'timestamptz' },
        metadata: { type: 'jsonb', default: pgm.func("'{}'::jsonb"), notNull: true }
    });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.dropTable('refresh_token');
    pgm.dropTable('user_group');
    pgm.dropTable('user_permission');
    pgm.dropTable('group_permission');
    pgm.dropTable('group');
    pgm.dropTable('user');
    pgm.dropFunction('generate_token_hash');
    pgm.dropDomain('token_hash');
};
