/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Profile extensions:
 *   - `user.avatar_url`           — cached avatar URL from the OAuth provider
 *                                    (GitHub today, Twitch later). Overridable
 *                                    by the user via PUT /user/me so we store
 *                                    it explicitly instead of re-deriving on
 *                                    every request.
 *   - `user_social_link`          — user-managed list of external profile
 *                                    links shown on the public profile page
 *                                    and (optionally) in the blog author card.
 *                                    Free-form label + URL to support niche
 *                                    platforms without schema changes.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('user', {
    avatar_url: { type: 'text' }
  });

  pgm.createTable('user_social_link', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'user',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    label: { type: 'varchar(60)', notNull: true },
    url: { type: 'text', notNull: true },
    sort_order: { type: 'int', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true },
    updated_at: { type: 'timestamptz' }
  });

  pgm.createIndex('user_social_link', ['user_id', 'sort_order']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('user_social_link');
  pgm.dropColumns('user', ['avatar_url']);
};
