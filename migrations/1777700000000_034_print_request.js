/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Print-Request flow — independent of the Drucker / Agent pipeline.
 *
 * A `print_request` is a human-to-human ticket: someone asks the owner
 * to print something, attaches an STL (server-side) or just a link to
 * an external model (Thingiverse, Printables, …), and gets a status +
 * comment thread back.
 *
 * Deliberately decoupled from `print_job`:
 *   - The owner can fulfil a request manually (USB-stick to printer)
 *     and just flip the status to `done` — no agent required.
 *   - Once the agent flow is live, a request that's been `accepted`
 *     and assigned a printer can spawn a `print_job` (linked via a
 *     follow-up FK if we want it; not added here to keep the schema
 *     minimal until that flow exists).
 *
 * Permissions live in user_permission as `print.request` (file an own
 * request, see + comment on own) and `print.moderate` (see all,
 * change status, assign printer, comment as moderator). Both seeded
 * to ADMIN_EMAILS in `bootstrap.ts`.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.createTable('print_request', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        requester_user_id: {
            type: 'uuid',
            notNull: true,
            references: 'user',
            onDelete: 'CASCADE'
        },
        title: { type: 'varchar(120)', notNull: true },
        description: { type: 'text' },
        // Discriminator — UI shows different details per source, and
        // the validation differs (one of stl_file_id / external_url
        // must be set, never both).
        source_type: {
            type: 'varchar(20)',
            notNull: true,
            check: "source_type IN ('stl_upload','external_link')"
        },
        stl_file_id: {
            type: 'uuid',
            references: 'stl_file',
            // SET NULL rather than CASCADE: if the STL gets deleted
            // we don't want the request to vanish along with its
            // comment history.
            onDelete: 'SET NULL'
        },
        external_url: { type: 'varchar(2048)' },
        // Cross-field validation: source_type matches the populated
        // field. Postgres CHECK runs per-row, so the constraint is
        // safe with future schema additions.
        // Allow-null on the unused side — that's the discriminator's job.
        // CHECK enforces "the right one is non-null".
        // Done as a separate sql() call below because pgm doesn't take
        // multi-column check constraints inline cleanly.

        // Optional printer assignment by the moderator. Nullable
        // because a request might be rejected, cancelled, or fulfilled
        // on a printer not registered in the system.
        assigned_printer_id: {
            type: 'uuid',
            references: 'printer',
            onDelete: 'SET NULL'
        },
        status: {
            type: 'varchar(20)',
            notNull: true,
            default: 'new',
            check: "status IN ('new','accepted','printing','done','rejected','cancelled')"
        },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamptz' }
    });

    // Cross-field invariant: STL upload populates stl_file_id, link
    // populates external_url. The "wrong" field stays NULL.
    pgm.sql(`
      ALTER TABLE public."print_request"
      ADD CONSTRAINT print_request_source_consistent
      CHECK (
        (source_type = 'stl_upload'   AND stl_file_id IS NOT NULL AND external_url IS NULL) OR
        (source_type = 'external_link' AND external_url IS NOT NULL AND stl_file_id IS NULL)
      );
    `);

    // Hot paths: my-requests (requester scoped) and the moderator
    // queue (status-scoped, newest first).
    pgm.createIndex(
        'print_request',
        ['requester_user_id', { name: 'created_at', sort: 'DESC' }],
        { name: 'print_request_requester_idx' }
    );
    pgm.createIndex(
        'print_request',
        ['status', { name: 'created_at', sort: 'DESC' }],
        { name: 'print_request_status_idx' }
    );

    pgm.createTable('print_request_comment', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        request_id: {
            type: 'uuid',
            notNull: true,
            references: 'print_request',
            onDelete: 'CASCADE'
        },
        author_user_id: {
            type: 'uuid',
            notNull: true,
            references: 'user',
            // SET NULL would lose attribution — but the user table is
            // CASCADE for everything else, so deleted users wipe their
            // comments too. Acceptable for an MVP request thread.
            onDelete: 'CASCADE'
        },
        body: { type: 'text', notNull: true, check: "char_length(body) BETWEEN 1 AND 4000" },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') }
    });

    pgm.createIndex(
        'print_request_comment',
        ['request_id', { name: 'created_at', sort: 'ASC' }],
        { name: 'print_request_comment_thread_idx' }
    );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.dropTable('print_request_comment');
    pgm.dropTable('print_request');
};
