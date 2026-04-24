/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * 3D-Printer Phase 2 — Request-Flow + feinere Berechtigungen.
 *
 * Ziel: Drucker gehört einem Owner, Freunde dürfen Druckanfragen stellen
 * und eigene G-Codes einreichen, der Owner/Operator moderiert. Der
 * Agent (Drucker selbst) darf nicht mehr eigenständig Jobs aus der Queue
 * ziehen — Start passiert explizit durch einen Menschen.
 *
 * Änderungen:
 *   - `printer_access.role` um `contributor` erweitert (zwischen operator
 *     und viewer). Erlaubt: eigene Anfragen anlegen, eigene G-Codes
 *     bearbeiten/löschen, eigene Jobs sehen. Nicht: Queue, Moderation.
 *   - `printer_access.can_view_queue` als explizites Flag. Owner und
 *     Operator bekommen es on-default, Contributor/Viewer per Grant vom
 *     Owner. Damit kann der Owner pro User entscheiden, wer mitliest.
 *   - `print_job.state` um `requested` erweitert. Das ist jetzt der
 *     Default-Anfangsstate. `queued` bedeutet „vom Owner genehmigt und
 *     eingereiht" — nur Owner/Operator kann dort hin wechseln. Ein
 *     abgelehnter Job landet in `cancelled` mit Grund im error_message.
 *
 * Down: Jobs im neuen Zwischenstate `requested` werden beim Rollback zu
 * `cancelled` gezwungen — sonst wäre der CHECK constraint nach
 * ALTER unlösbar. Rollback ist destruktiv, aber konsistent.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    // ─── printer_access: neue Rolle contributor ────────────────────────
    pgm.sql(`
      ALTER TABLE public."printer_access"
        DROP CONSTRAINT IF EXISTS printer_access_role_check;
      ALTER TABLE public."printer_access"
        ADD CONSTRAINT printer_access_role_check
        CHECK (role IN ('owner','operator','contributor','viewer'));
    `);

    // Queue-Sichtbarkeit. Für Bestandsdaten: owner/operator bekommen
    // true, alle anderen false. Frischer Grant kann es pro Zeile
    // anders setzen.
    pgm.addColumns('printer_access', {
        can_view_queue: { type: 'boolean', notNull: true, default: false }
    });
    pgm.sql(`
      UPDATE public."printer_access"
      SET can_view_queue = true
      WHERE role IN ('owner', 'operator');
    `);

    // ─── print_job: neuer State requested ──────────────────────────────
    pgm.sql(`
      ALTER TABLE public."print_job"
        DROP CONSTRAINT IF EXISTS print_job_state_check;
      ALTER TABLE public."print_job"
        ADD CONSTRAINT print_job_state_check
        CHECK (state IN ('requested','queued','transferring','printing','paused','completed','failed','cancelled'));
    `);

    // Default auf requested: neue Inserts landen so, wenn der Service
    // nichts explizit setzt. Legacy-Zeilen bleiben wie sie sind.
    pgm.alterColumn('print_job', 'state', {
        default: 'requested'
    });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    // Default auf queued zurück
    pgm.alterColumn('print_job', 'state', { default: 'queued' });

    // requested-Jobs in cancelled überführen, damit der engere CHECK
    // nicht sofort failed.
    pgm.sql(`
      UPDATE public."print_job"
      SET state = 'cancelled',
          finished_at = COALESCE(finished_at, NOW()),
          error_message = COALESCE(error_message, 'Rollback: state requested removed')
      WHERE state = 'requested';
    `);
    pgm.sql(`
      ALTER TABLE public."print_job"
        DROP CONSTRAINT IF EXISTS print_job_state_check;
      ALTER TABLE public."print_job"
        ADD CONSTRAINT print_job_state_check
        CHECK (state IN ('queued','transferring','printing','paused','completed','failed','cancelled'));
    `);

    pgm.dropColumns('printer_access', ['can_view_queue']);

    // Contributor-Zeilen downgraden auf viewer, damit der engere CHECK
    // passt. Informationsverlust, aber der einzige sichere Reverse.
    pgm.sql(`
      UPDATE public."printer_access"
      SET role = 'viewer'
      WHERE role = 'contributor';
    `);
    pgm.sql(`
      ALTER TABLE public."printer_access"
        DROP CONSTRAINT IF EXISTS printer_access_role_check;
      ALTER TABLE public."printer_access"
        ADD CONSTRAINT printer_access_role_check
        CHECK (role IN ('owner','operator','viewer'));
    `);
};
