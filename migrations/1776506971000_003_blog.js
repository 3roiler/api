/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
    // Blog posts. Markdown in `content`, nullable `published_at` doubles as
    // draft flag (NULL = draft, NOT NULL = live).
    pgm.createTable('blog_post', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        author_id: {
            type: 'uuid',
            notNull: true,
            references: 'user',
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE'
        },
        slug: {
            type: 'varchar(120)',
            notNull: true,
            match: "^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/i"
        },
        title: { type: 'varchar(200)', notNull: true },
        excerpt: { type: 'varchar(400)' },
        content: { type: 'text', notNull: true },
        published_at: { type: 'timestamptz' },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true },
        updated_at: { type: 'timestamptz' }
    });

    // Unique slug, plus an index for the common "newest published posts" query.
    pgm.createIndex('blog_post', 'slug', { unique: true, name: 'blog_post_slug_key' });
    pgm.createIndex('blog_post', [{ name: 'published_at', sort: 'DESC' }], {
        name: 'blog_post_published_at_idx',
        where: 'published_at IS NOT NULL'
    });

    // Partial unique index on email: email itself is still nullable (OAuth
    // providers don't always expose it), but when set it must be unique so
    // cross-provider linking by email is unambiguous.
    pgm.createIndex('user', 'email', {
        unique: true,
        name: 'user_email_unique_idx',
        where: 'email IS NOT NULL'
    });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.dropIndex('user', 'email', { name: 'user_email_unique_idx' });
    pgm.dropTable('blog_post');
};
