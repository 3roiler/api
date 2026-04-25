import type { PoolClient, QueryResult } from 'pg';
import { createHash } from 'node:crypto';
import persistence from './persistence.js';
import AppError from './error.js';
import { sanitiseFilename } from './file-helpers.js';
import type { StlFile, StlMetadata } from '../models/index.js';

/**
 * Metadata-only projection. The bytea blob lives in `stl_file_content`
 * and never enters list/detail queries — only the viewer pulls it via
 * `getContent`.
 */
const STL_COLUMNS = `
  sf.id,
  sf.uploaded_by_user_id AS "uploadedByUserId",
  sf.original_filename AS "originalFilename",
  sf.sha256,
  sf.size_bytes AS "sizeBytes",
  sf.metadata,
  sf.created_at AS "createdAt"
`;

/**
 * Detects whether the buffer is an ASCII or binary STL — or neither.
 *
 * Binary STL is fixed-layout (80-byte header + 4-byte triangle count +
 * 50 bytes per triangle), so we can verify it by checking the byte
 * count exactly matches the declared triangles. That's the most
 * reliable test, hence we try it first.
 *
 * ASCII STL starts with the literal `solid` (case-insensitive). Some
 * exporters write `solid foo` and then ship binary anyway — covered
 * because the binary check has already passed.
 *
 * Returns `null` if neither matches; the caller surfaces a 400.
 */
function detectStlFormat(buffer: Buffer): 'ascii' | 'binary' | null {
  if (buffer.length < 84) return null;

  const triangleCount = buffer.readUInt32LE(80);
  if (buffer.length === 84 + triangleCount * 50) {
    return 'binary';
  }

  const head = buffer.subarray(0, 1024).toString('ascii').toLowerCase();
  if (head.trimStart().startsWith('solid')) {
    return 'ascii';
  }
  return null;
}

/**
 * Counts triangles in an ASCII STL by counting `facet normal` lines.
 * Only scans the first 4 MB to keep the parse cheap on huge files —
 * for visualisation accuracy a sampled count is plenty.
 */
function countAsciiTriangles(buffer: Buffer): number {
  const limit = Math.min(buffer.length, 4 * 1024 * 1024);
  const text = buffer.subarray(0, limit).toString('utf8');
  const matches = text.match(/facet normal/gi);
  return matches?.length ?? 0;
}

export interface UploadStlOptions {
  filename: string;
  buffer: Buffer;
  uploadedByUserId: string;
}

export class StlService {
  /**
   * Validates, hashes, parses metadata, deduplicates by SHA-256, and
   * stores the bytea blob atomically. Identical re-upload returns the
   * existing row (no new content blob written).
   */
  async uploadStl(options: UploadStlOptions): Promise<StlFile> {
    const { filename, buffer, uploadedByUserId } = options;

    const format = detectStlFormat(buffer);
    if (!format) {
      throw AppError.badRequest(
        'Datei sieht nicht wie STL aus (weder gültiger Binary-Header noch ASCII "solid"-Anfang).',
        'BAD_STL_MAGIC'
      );
    }

    const triangleCount =
      format === 'binary' ? buffer.readUInt32LE(80) : countAsciiTriangles(buffer);

    const cleanName = sanitiseFilename(filename, 'model.stl');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const metadata: StlMetadata = { format, triangleCount };

    return this.withTx(async (client) => {
      const existing: QueryResult<StlFile> = await client.query(
        `SELECT ${STL_COLUMNS} FROM public."stl_file" sf WHERE sf.sha256 = $1`,
        [sha256]
      );
      if (existing.rows[0]) {
        return existing.rows[0];
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public."stl_file"
           (uploaded_by_user_id, original_filename, sha256, size_bytes, metadata)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
         RETURNING id`,
        [uploadedByUserId, cleanName, sha256, buffer.length, JSON.stringify(metadata)]
      );
      const fileId = inserted.rows[0].id;

      await client.query(
        `INSERT INTO public."stl_file_content" (file_id, content)
         VALUES ($1::uuid, $2)`,
        [fileId, buffer]
      );

      const fresh: QueryResult<StlFile> = await client.query(
        `SELECT ${STL_COLUMNS} FROM public."stl_file" sf WHERE sf.id = $1::uuid`,
        [fileId]
      );
      return fresh.rows[0];
    });
  }

  async listForUser(userId: string, limit = 50, offset = 0): Promise<StlFile[]> {
    const result: QueryResult<StlFile> = await persistence.database.query(
      `SELECT ${STL_COLUMNS}
       FROM public."stl_file" sf
       WHERE sf.uploaded_by_user_id = $1::uuid
       ORDER BY sf.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    return result.rows;
  }

  async getById(id: string): Promise<StlFile | null> {
    const result: QueryResult<StlFile> = await persistence.database.query(
      `SELECT ${STL_COLUMNS} FROM public."stl_file" sf WHERE sf.id = $1::uuid`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Loads the binary content. Streamed back from the controller as
   * `application/octet-stream` for the in-browser viewer (three.js
   * STLLoader handles both ASCII and binary).
   */
  async getContent(id: string): Promise<Buffer | null> {
    const result: QueryResult<{ content: Buffer }> = await persistence.database.query(
      `SELECT content FROM public."stl_file_content" WHERE file_id = $1::uuid`,
      [id]
    );
    return result.rows[0]?.content ?? null;
  }

  async deleteStl(id: string): Promise<boolean> {
    const result = await persistence.database.query(
      `DELETE FROM public."stl_file" WHERE id = $1::uuid`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
}

export default new StlService();
