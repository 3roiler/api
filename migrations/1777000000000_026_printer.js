/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * 3D-Printer-Integration — Phase 1 Schema.
 *
 * Kern-Entitäten:
 *  - `printer`              – registrierter Drucker + Agent-Token-Hash
 *  - `printer_access`       – owner/operator/viewer + Kamera-Flag
 *  - `gcode_file`           – Metadaten (Name, Hash, Größe, Slicer-Info)
 *  - `gcode_file_content`   – bytea in separater Tabelle, damit Listen-
 *                             Queries über `gcode_file` TOAST-frei bleiben
 *  - `print_job`            – Druckauftrag + Queue-Slot (priority/state)
 *  - `print_event`          – Append-only Audit-Log je Job
 *
 * Queue-Position ist KEINE eigene Spalte/Tabelle: sie ergibt sich aus
 * `state='queued'` plus `ORDER BY priority DESC, queued_at ASC`.
 *
 * Agent-Token speichern wir als 64-char SHA-256-Hex (domain `token_hash`
 * aus Migration 001). Klartext sieht der Owner nur einmal bei Create.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.createTable('printer', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        name: { type: 'varchar(60)', notNull: true },
        model: { type: 'varchar(60)', notNull: true },
        agent_token_hash: { type: 'token_hash', notNull: true, unique: true },
        agent_version: { type: 'varchar(40)' },
        status: {
            type: 'varchar(20)',
            notNull: true,
            default: 'offline',
            check: "status IN ('offline','online','error')"
        },
        last_seen_at: { type: 'timestamptz' },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true },
        updated_at: { type: 'timestamptz' }
    });

    pgm.createTable('printer_access', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        printer_id: {
            type: 'uuid',
            notNull: true,
            references: 'printer',
            onDelete: 'CASCADE'
        },
        user_id: {
            type: 'uuid',
            notNull: true,
            references: 'user',
            onDelete: 'CASCADE'
        },
        role: {
            type: 'varchar(20)',
            notNull: true,
            check: "role IN ('owner','operator','viewer')"
        },
        can_view_camera: { type: 'boolean', notNull: true, default: false },
        granted_by: {
            type: 'uuid',
            references: 'user',
            onDelete: 'SET NULL'
        },
        granted_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });

    pgm.createIndex('printer_access', ['printer_id', 'user_id'], {
        unique: true,
        name: 'printer_access_unique_idx'
    });
    pgm.createIndex('printer_access', 'user_id', { name: 'printer_access_user_idx' });
    // Genau ein owner je Drucker — DB-seitige Invariante, damit ein Bug im
    // Service-Layer nicht aus Versehen zwei gleichzeitige Eigentümer anlegt.
    pgm.createIndex('printer_access', 'printer_id', {
        unique: true,
        name: 'printer_access_single_owner_idx',
        where: "role = 'owner'"
    });

    pgm.createTable('gcode_file', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        uploaded_by_user_id: {
            type: 'uuid',
            references: 'user',
            onDelete: 'SET NULL'
        },
        original_filename: { type: 'varchar(255)', notNull: true },
        sha256: { type: 'char(64)', notNull: true },
        size_bytes: { type: 'bigint', notNull: true },
        metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });

    pgm.createIndex('gcode_file', ['uploaded_by_user_id', { name: 'created_at', sort: 'DESC' }], {
        name: 'gcode_file_uploader_idx'
    });
    pgm.createIndex('gcode_file', 'sha256', { name: 'gcode_file_sha256_idx' });

    // Separate Content-Tabelle: sonst toastet jede gcode_file-Zeile den
    // kompletten Blob bei SELECT * mit und Listenansichten werden teuer.
    // 1:1 über `file_id` als PK+FK.
    pgm.createTable('gcode_file_content', {
        file_id: {
            type: 'uuid',
            primaryKey: true,
            references: 'gcode_file',
            onDelete: 'CASCADE'
        },
        content: { type: 'bytea', notNull: true }
    });

    pgm.createTable('print_job', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        printer_id: {
            type: 'uuid',
            notNull: true,
            references: 'printer',
            onDelete: 'CASCADE'
        },
        user_id: {
            type: 'uuid',
            references: 'user',
            onDelete: 'SET NULL'
        },
        gcode_file_id: {
            type: 'uuid',
            notNull: true,
            references: 'gcode_file',
            onDelete: 'RESTRICT'
        },
        state: {
            type: 'varchar(20)',
            notNull: true,
            default: 'queued',
            check: "state IN ('queued','transferring','printing','paused','completed','failed','cancelled')"
        },
        priority: { type: 'integer', notNull: true, default: 0 },
        queued_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        started_at: { type: 'timestamptz' },
        finished_at: { type: 'timestamptz' },
        error_message: { type: 'text' },
        moonraker_job_id: { type: 'varchar(80)' },
        progress: { type: 'real', check: 'progress IS NULL OR (progress >= 0 AND progress <= 1)' }
    });

    // Hot-Path: Queue-Runner holt den nächsten Job je Drucker.
    pgm.createIndex(
        'print_job',
        [
            'printer_id',
            'state',
            { name: 'priority', sort: 'DESC' },
            { name: 'queued_at', sort: 'ASC' }
        ],
        { name: 'print_job_queue_idx' }
    );
    pgm.createIndex('print_job', ['user_id', { name: 'queued_at', sort: 'DESC' }], {
        name: 'print_job_user_idx'
    });

    pgm.createTable('print_event', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        print_job_id: {
            type: 'uuid',
            notNull: true,
            references: 'print_job',
            onDelete: 'CASCADE'
        },
        event_type: { type: 'varchar(40)', notNull: true },
        payload: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
        ts: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') }
    });

    pgm.createIndex('print_event', ['print_job_id', { name: 'ts', sort: 'DESC' }], {
        name: 'print_event_job_idx'
    });
    pgm.createIndex('print_event', [{ name: 'ts', sort: 'DESC' }], {
        name: 'print_event_timeline_idx'
    });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.dropTable('print_event');
    pgm.dropTable('print_job');
    pgm.dropTable('gcode_file_content');
    pgm.dropTable('gcode_file');
    pgm.dropTable('printer_access');
    pgm.dropTable('printer');
};
