/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * STL-Dateien als eigene Ressource.
 *
 * Warum nicht in `gcode_file`? STLs sind Slicer-Eingaben, keine
 * Drucker-Eingaben — sie haben einen anderen Lifecycle (Upload → ggf.
 * Slicing → G-Code → Druck). Eigener Tisch hält die Tabellen sauber
 * für Listen-Queries und macht spätere Slicing-Pipelines (z. B. eine
 * `slicer_job`-Tabelle) leichter zu modellieren, ohne G-Code-Spalten
 * mitzuziehen.
 *
 * Schema spiegelt `gcode_file` 1:1: Metadaten + bytea in eigener
 * Tabelle, damit Listen-Queries TOAST-frei bleiben und der Blob nur
 * gefetcht wird, wenn der Viewer ihn braucht.
 *
 * Kein Print-Job-FK — Slicing ist Phase 2, bis dahin sind STLs reines
 * „Vorratslager" mit Browser-Viewer.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.createTable('stl_file', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
        uploaded_by_user_id: {
            type: 'uuid',
            references: 'user',
            onDelete: 'SET NULL'
        },
        original_filename: { type: 'varchar(255)', notNull: true },
        sha256: { type: 'char(64)', notNull: true },
        size_bytes: { type: 'bigint', notNull: true },
        // metadata.format: 'ascii' | 'binary'
        // metadata.triangleCount: int
        metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
        created_at: { type: 'timestamptz', default: pgm.func('current_timestamp'), notNull: true }
    });

    pgm.createIndex(
        'stl_file',
        ['uploaded_by_user_id', { name: 'created_at', sort: 'DESC' }],
        { name: 'stl_file_uploader_idx' }
    );
    pgm.createIndex('stl_file', 'sha256', { name: 'stl_file_sha256_idx' });

    pgm.createTable('stl_file_content', {
        file_id: {
            type: 'uuid',
            primaryKey: true,
            references: 'stl_file',
            onDelete: 'CASCADE'
        },
        content: { type: 'bytea', notNull: true }
    });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.dropTable('stl_file_content');
    pgm.dropTable('stl_file');
};
