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

    pgm.createTable('users', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        github_id: { type: 'text', unique: true },
        username: { type: 'varchar(150)', notNull: true, unique: true },
        display_name: { type: 'varchar(150)' },
        email: { type: 'varchar(320)' },
        avatar_url: { type: 'text' },
        profile_url: { type: 'text' },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true },
        updated_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });

    pgm.createTable('groups', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        slug: { type: 'varchar(120)', notNull: true, unique: true },
        name: { type: 'varchar(150)', notNull: true },
        description: { type: 'text' },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true },
        updated_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });

    pgm.createTable('scopes', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        key: { type: 'varchar(150)', notNull: true, unique: true },
        description: { type: 'text' },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true },
        updated_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });

    pgm.createTable('user_groups', {
        user_id: {
            type: 'uuid',
            notNull: true,
            references: 'users',
            onDelete: 'cascade'
        },
        group_id: {
            type: 'uuid',
            notNull: true,
            references: 'groups',
            onDelete: 'cascade'
        },
        assigned_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });
    pgm.addConstraint('user_groups', 'user_groups_pkey', { primaryKey: ['user_id', 'group_id'] });

    pgm.createTable('group_scopes', {
        group_id: {
            type: 'uuid',
            notNull: true,
            references: 'groups',
            onDelete: 'cascade'
        },
        scope_id: {
            type: 'uuid',
            notNull: true,
            references: 'scopes',
            onDelete: 'cascade'
        },
        granted_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });
    pgm.addConstraint('group_scopes', 'group_scopes_pkey', { primaryKey: ['group_id', 'scope_id'] });

    pgm.createTable('group_dependencies', {
        group_id: {
            type: 'uuid',
            notNull: true,
            references: 'groups',
            onDelete: 'cascade'
        },
        dependency_group_id: {
            type: 'uuid',
            notNull: true,
            references: 'groups',
            onDelete: 'cascade'
        },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });
    pgm.addConstraint('group_dependencies', 'group_dependencies_primary', {
        primaryKey: ['group_id', 'dependency_group_id']
    });
    pgm.addConstraint('group_dependencies', 'group_dependencies_no_self_reference', {
        check: 'group_id <> dependency_group_id'
    });

    pgm.createIndex('user_groups', ['group_id']);
    pgm.createIndex('user_groups', ['user_id']);
    pgm.createIndex('group_scopes', ['scope_id']);
    pgm.createIndex('group_scopes', ['group_id']);
    pgm.createIndex('group_dependencies', ['dependency_group_id']);
    pgm.createIndex('group_dependencies', ['group_id']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.dropTable('group_dependencies');
    pgm.dropTable('group_scopes');
    pgm.dropTable('user_groups');
    pgm.dropTable('scopes');
    pgm.dropTable('groups');
    pgm.dropTable('users');
};
