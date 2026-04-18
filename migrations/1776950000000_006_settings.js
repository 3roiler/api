/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Settings framework.
 *
 * Two tables: one for plain-text configuration, one for secrets. Both are
 * key-value with JSONB for the payload so we don't have to write a new
 * migration every time the admin UI grows a new toggle.
 *
 * - `app_setting` — plain JSON values. Readable in the admin UI and
 *   serialisable straight to the client (e.g. feature flags, the
 *   DigitalOcean app ID, metric refresh defaults, …).
 * - `app_secret`  — AES-256-GCM-encrypted payload. The actual secret
 *   (`ciphertext`) is never returned by read endpoints; only
 *   `hasValue`/`preview` are exposed. Encryption happens in the Node
 *   layer using `SECRETS_KEY` (32-byte base64). Storing ciphertext+iv+tag
 *   separately lets us rotate the key later without a schema change.
 *
 * `updated_by` points at the user who last wrote the row so auditing is
 * trivial; `ON DELETE SET NULL` because we'd rather keep the setting
 * than lose it when a user is removed.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable('app_setting', {
    key: {
      type: 'varchar(120)',
      primaryKey: true,
      // Namespaced dotted keys keep the table flat but readable,
      // e.g. `digitalocean.app_id`, `metrics.refresh_default_seconds`.
      check: "key ~ '^[a-z][a-z0-9_.-]{1,118}[a-z0-9]$'"
    },
    value: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'null'::jsonb")
    },
    description: { type: 'text' },
    updated_by: {
      type: 'uuid',
      references: 'user',
      onDelete: 'SET NULL'
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp')
    }
  });

  pgm.createTable('app_secret', {
    key: {
      type: 'varchar(120)',
      primaryKey: true,
      check: "key ~ '^[a-z][a-z0-9_.-]{1,118}[a-z0-9]$'"
    },
    // AES-256-GCM: iv is 12 bytes, tag is 16 bytes. Ciphertext length
    // equals plaintext length — we don't pad. `bytea` keeps them as raw
    // binary so we don't waste ~30% on base64 at rest.
    ciphertext: { type: 'bytea', notNull: true },
    iv:         { type: 'bytea', notNull: true },
    auth_tag:   { type: 'bytea', notNull: true },
    // Short non-sensitive hint the UI can show without decrypting,
    // e.g. "Token: dop_v1_…a7f2" or the count of stored bytes. Always
    // derived from the plaintext in the service layer before encryption.
    preview:    { type: 'varchar(120)' },
    description: { type: 'text' },
    updated_by: {
      type: 'uuid',
      references: 'user',
      onDelete: 'SET NULL'
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp')
    }
  });

  // The new `dashboard.settings` permission key is seeded per login in the
  // bootstrap hook, but having an explicit row in a catalog table is out of
  // scope — the permission catalog is hard-coded in `services/permissions.ts`.
  // No data to seed here.
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('app_secret');
  pgm.dropTable('app_setting');
};
