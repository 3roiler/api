/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Audit-Trail für Moderator-Restores eines Kommentars. Vorher ging die
 * Mod-Aktion verloren, sobald jemand „Wiederherstellen" geklickt hat —
 * weder im Frontend noch in der DB war später nachvollziehbar, dass
 * der Comment mal mod-gelöscht und wieder freigegeben wurde.
 *
 * Drei neue Spalten an `comment`:
 *  - `restored_at` — wann?
 *  - `restored_by_user_id` — welcher Mod?
 *  - `last_deletion_reason` — welcher Grund wurde gerade restoret?
 *    (Der `deletion_reason` muss beim Restore auf NULL gehen, damit
 *    das Frontend den Comment wieder anzeigt — aber für den Audit
 *    wollen wir den letzten Grund behalten.)
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.addColumns('comment', {
        restored_at: { type: 'timestamptz' },
        restored_by_user_id: {
            type: 'uuid',
            references: '"user"(id)',
            onDelete: 'SET NULL'
        },
        last_deletion_reason: { type: 'text' }
    });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.dropColumns('comment', ['restored_at', 'restored_by_user_id', 'last_deletion_reason']);
};
