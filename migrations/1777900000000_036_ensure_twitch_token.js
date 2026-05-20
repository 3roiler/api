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
 * Umgesetzt mit rohem SQL (statt `pgm.createTable` wie in 002): das
 * `IF NOT EXISTS` macht die Reparatur idempotent (Prod wird repariert,
 * überall sonst No-op) und die abweichende Syntax vermeidet zugleich die
 * Code-Duplikation mit 002_twitch. Struktur ist identisch.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS twitch_id varchar(255) UNIQUE;

        CREATE TABLE IF NOT EXISTS public."twitch_token" (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL UNIQUE REFERENCES public."user" ON DELETE CASCADE ON UPDATE CASCADE,
            twitch_user_id varchar(255) NOT NULL,
            twitch_login varchar(255) NOT NULL,
            access_token text NOT NULL,
            refresh_token text NOT NULL,
            scopes text NOT NULL DEFAULT '',
            expires_at timestamptz NOT NULL,
            created_at timestamptz NOT NULL DEFAULT current_timestamp,
            updated_at timestamptz
        );
    `);
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
