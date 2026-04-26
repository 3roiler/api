import type { PoolClient, QueryResult } from 'pg';
import persistence from './persistence.js';

/**
 * Generic file-asset persistence layer used by `gcode.ts` and `stl.ts`.
 *
 * Both services historically had identical implementations of
 * list/get/getContent/delete plus an identical `withTx` boilerplate —
 * the per-asset code only differed in the table name, the bytea
 * content table, and the magic-byte / metadata bits. This module
 * extracts everything that's table-agnostic; the per-asset upload
 * pipeline (which validates and emits format-specific metadata) keeps
 * living in its own service file.
 *
 * The column projection is shared too: every asset table uses the same
 * shape (id, uploaded_by_user_id, original_filename, sha256,
 * size_bytes, metadata, created_at). New asset types just have to keep
 * that contract — no per-table projection string needed.
 */

export interface AssetFileBase {
  id: string;
  uploadedByUserId: string | null;
  originalFilename: string;
  sha256: string;
  sizeBytes: number;
  /**
   * Per-asset metadata. Typed as `unknown` so concrete asset types
   * (`GcodeFile`, `StlFile`, …) can carry their own narrowly-typed
   * metadata interfaces without being incompatible with the base
   * constraint here. The store itself just round-trips the value
   * through JSONB.
   */
  metadata: unknown;
  createdAt: Date;
}

/**
 * Centralised projection so an extra column added to one asset table
 * doesn't silently leak through here. Aliased with `f` so every query
 * built from this string can `FROM <table> f` consistently.
 */
export const ASSET_COLUMNS = `
  f.id,
  f.uploaded_by_user_id AS "uploadedByUserId",
  f.original_filename AS "originalFilename",
  f.sha256,
  f.size_bytes AS "sizeBytes",
  f.metadata,
  f.created_at AS "createdAt"
`;

export interface AssetStoreConfig {
  /** Metadata-table name (e.g. 'gcode_file'). */
  table: string;
  /** bytea content-table name (e.g. 'gcode_file_content'). */
  contentTable: string;
}

export interface AssetUploadOptions {
  uploadedByUserId: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  /** Caller's typed metadata; gets `JSON.stringify`-d into the JSONB
   *  column so any serialisable shape works. */
  metadata: unknown;
  content: Buffer;
}

export interface AssetStore<TFile extends AssetFileBase> {
  list(userId: string, limit: number, offset: number): Promise<TFile[]>;
  getById(id: string): Promise<TFile | null>;
  getContent(id: string): Promise<Buffer | null>;
  delete(id: string): Promise<boolean>;

  /**
   * Looks up an existing file by its content hash inside an open
   * transaction. Used to short-circuit duplicate uploads without
   * writing a new content blob. Caller is responsible for the
   * surrounding `withTx`.
   */
  findBySha256(client: PoolClient, sha256: string): Promise<TFile | null>;

  /**
   * Inserts both the metadata row and the bytea content in one
   * transaction step, then returns the freshly-projected file. Caller
   * is responsible for the surrounding `withTx` so the upload service
   * can do its own dedup-then-insert flow.
   */
  insertContent(client: PoolClient, opts: AssetUploadOptions): Promise<TFile>;

  /** Standard BEGIN/COMMIT/ROLLBACK helper. Used by every per-asset
   *  upload to wrap dedup + insert into one transaction. */
  withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

/**
 * Builds the shared list/get/delete + tx helpers for an asset table
 * pair. `table` and `contentTable` are interpolated into the SQL —
 * they MUST be hard-coded by the caller, never derived from user
 * input, to keep this safe from injection.
 */
export function createAssetStore<TFile extends AssetFileBase>(
  config: AssetStoreConfig
): AssetStore<TFile> {
  const { table, contentTable } = config;

  async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await persistence.database.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    async list(userId, limit, offset) {
      const result: QueryResult<TFile> = await persistence.database.query(
        `SELECT ${ASSET_COLUMNS}
         FROM public."${table}" f
         WHERE f.uploaded_by_user_id = $1::uuid
         ORDER BY f.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );
      return result.rows;
    },

    async getById(id) {
      const result: QueryResult<TFile> = await persistence.database.query(
        `SELECT ${ASSET_COLUMNS} FROM public."${table}" f WHERE f.id = $1::uuid`,
        [id]
      );
      return result.rows[0] ?? null;
    },

    async getContent(id) {
      const result: QueryResult<{ content: Buffer }> = await persistence.database.query(
        `SELECT content FROM public."${contentTable}" WHERE file_id = $1::uuid`,
        [id]
      );
      return result.rows[0]?.content ?? null;
    },

    async delete(id) {
      const result = await persistence.database.query(
        `DELETE FROM public."${table}" WHERE id = $1::uuid`,
        [id]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async findBySha256(client, sha256) {
      const result: QueryResult<TFile> = await client.query(
        `SELECT ${ASSET_COLUMNS} FROM public."${table}" f WHERE f.sha256 = $1`,
        [sha256]
      );
      return result.rows[0] ?? null;
    },

    async insertContent(client, opts) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public."${table}"
           (uploaded_by_user_id, original_filename, sha256, size_bytes, metadata)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
         RETURNING id`,
        [
          opts.uploadedByUserId,
          opts.filename,
          opts.sha256,
          opts.sizeBytes,
          JSON.stringify(opts.metadata)
        ]
      );
      const fileId = inserted.rows[0].id;

      await client.query(
        `INSERT INTO public."${contentTable}" (file_id, content)
         VALUES ($1::uuid, $2)`,
        [fileId, opts.content]
      );

      const fresh: QueryResult<TFile> = await client.query(
        `SELECT ${ASSET_COLUMNS} FROM public."${table}" f WHERE f.id = $1::uuid`,
        [fileId]
      );
      return fresh.rows[0];
    },

    withTx
  };
}
