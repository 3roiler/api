/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Blog-Visibility: a post can be `public` (anyone, current behaviour),
 * `authenticated` (any logged-in user), or `group` (only users in at least
 * one of the assigned groups). Group membership is modelled via a join
 * table so a post can live behind more than one group at once.
 *
 * Adds the new `dashboard.*` permission keys that the refreshed admin UI
 * will gate on. `admin.manage` stays the umbrella permission — the
 * bootstrap hook grants all new keys alongside it on the next boot / login.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  // Default 'public' keeps existing posts visible to everyone — we never
  // want a schema change to silently hide content.
  pgm.addColumn('blog_post', {
    visibility: {
      type: 'varchar(20)',
      notNull: true,
      default: 'public',
      check: "visibility IN ('public', 'authenticated', 'group')"
    }
  });

  // Index so the authenticated/group filter doesn't scan the whole table
  // once there are enough posts. Covers the most common list queries.
  pgm.createIndex('blog_post', 'visibility', {
    name: 'blog_post_visibility_idx'
  });

  // Join table for `visibility = 'group'`. Composite PK so the same post
  // can't be linked to the same group twice; FK cascades on delete on
  // both sides because there's no meaningful use for a dangling entry.
  pgm.createTable('blog_post_group_access', {
    post_id: {
      type: 'uuid',
      notNull: true,
      references: 'blog_post',
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
    created_at: {
      type: 'timestamptz',
      default: pgm.func('current_timestamp'),
      notNull: true
    }
  });

  pgm.addConstraint('blog_post_group_access', 'blog_post_group_access_pkey', {
    primaryKey: ['post_id', 'group_id']
  });

  // Reverse-lookup index: "which posts can this group see?" — used by the
  // listPosts visibility filter and by the admin UI when showing group
  // details.
  pgm.createIndex('blog_post_group_access', 'group_id', {
    name: 'blog_post_group_access_group_id_idx'
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('blog_post_group_access');
  pgm.dropIndex('blog_post', 'visibility', { name: 'blog_post_visibility_idx' });
  pgm.dropColumn('blog_post', 'visibility');
};
