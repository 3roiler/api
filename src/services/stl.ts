import { createHash } from 'node:crypto';
import AppError from './error.js';
import { sanitiseFilename, ensureBuffer } from './file-helpers.js';
import { createAssetStore } from './asset-store.js';
import type { StlFile, StlMetadata } from '../models/index.js';

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
function detectStlFormat(input: Buffer): 'ascii' | 'binary' | null {
  // CodeQL's type-confusion query doesn't follow the `asserts is
  // Buffer` form across call boundaries, so we inline the runtime
  // check + re-bind to a fresh `const buffer: Buffer` local right
  // before the first property access.
  if (!Buffer.isBuffer(input)) {
    throw new TypeError('Expected a Buffer instance.');
  }
  const buffer: Buffer = input;
  const length = buffer.length;
  if (length < 84) return null;

  const triangleCount = buffer.readUInt32LE(80);
  if (length === 84 + triangleCount * 50) {
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
function countAsciiTriangles(input: Buffer): number {
  const buffer = ensureBuffer(input);
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

const store = createAssetStore<StlFile>({
  table: 'stl_file',
  contentTable: 'stl_file_content'
});

export class StlService {
  /**
   * Validates STL magic bytes, parses metadata, deduplicates by
   * SHA-256 and stores the bytea atomically. Identical re-upload
   * returns the existing row — no new content blob written.
   */
  async uploadStl(options: UploadStlOptions): Promise<StlFile> {
    const { filename, buffer: rawBuffer, uploadedByUserId } = options;
    // Inline check + re-bind so CodeQL sees the type-guard in the
    // same scope as the `length` read it flagged.
    if (!Buffer.isBuffer(rawBuffer)) {
      throw new TypeError('Expected a Buffer instance.');
    }
    const buffer: Buffer = rawBuffer;
    const sizeBytes: number = buffer.length;

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

    return store.withTx(async (client) => {
      const existing = await store.findBySha256(client, sha256);
      if (existing) return existing;
      return store.insertContent(client, {
        uploadedByUserId,
        filename: cleanName,
        sha256,
        sizeBytes,
        metadata,
        content: buffer
      });
    });
  }

  // The plain CRUD now lives in the store factory — these are thin
  // arrow re-exports so existing callers keep their imports.
  listForUser = (userId: string, limit = 50, offset = 0): Promise<StlFile[]> =>
    store.list(userId, limit, offset);
  getById = (id: string): Promise<StlFile | null> => store.getById(id);
  getContent = (id: string): Promise<Buffer | null> => store.getContent(id);
  deleteStl = (id: string): Promise<boolean> => store.delete(id);
}

export default new StlService();
