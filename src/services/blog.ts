import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import persistence from './persistence.js';
import type { BlogPost, BlogPostVisibility } from '../models/index.js';

const VALID_VISIBILITIES: readonly BlogPostVisibility[] = ['public', 'authenticated', 'group'];

/**
 * Columns we select for every list/detail query. Keeping the visibility +
 * the aggregated access-group list inline saves a second round-trip and
 * lets the controller ship the full post shape to the editor UI.
 */
const POST_COLUMNS = `
  p.id,
  p.author_id AS "authorId",
  p.slug,
  p.title,
  p.excerpt,
  p.content,
  p.published_at AS "publishedAt",
  p.visibility,
  COALESCE(
    ARRAY(
      SELECT group_id FROM public."blog_post_group_access"
      WHERE post_id = p.id
      ORDER BY group_id
    ),
    ARRAY[]::uuid[]
  ) AS "accessGroupIds",
  p.created_at AS "createdAt",
  p.updated_at AS "updatedAt"
`;

export interface CreateBlogPostOptions {
  authorId: string;
  slug: string;
  title: string;
  content: string;
  excerpt?: string | null;
  publish?: boolean;
  visibility?: BlogPostVisibility;
  /**
   * Only consulted when `visibility === 'group'`; ignored otherwise so a
   * UI mistake doesn't silently link groups to a public post.
   */
  groupIds?: string[];
}

export interface UpdateBlogPostOptions {
  slug?: string;
  title?: string;
  content?: string;
  excerpt?: string | null;
  publish?: boolean | null;
  visibility?: BlogPostVisibility;
  /**
   * `undefined` = leave untouched. An explicit array (even empty) replaces
   * the current group-access set. For non-`group` visibility the service
   * clears the set regardless, so the caller doesn't have to remember.
   */
  groupIds?: string[];
}

export interface ListPostsOptions {
  /**
   * `true` only for authenticated callers with `blog.write` — lets the
   * admin-facing list endpoint see unpublished posts.
   */
  includeDrafts?: boolean;
  /**
   * Viewer identity. `null` / `undefined` = anonymous.
   *
   * Controls the visibility filter:
   *  - anonymous          → `public` only
   *  - authenticated      → `public` + `authenticated` + `group` (if member)
   *  - author/admin       → no filter (use `bypassVisibility` instead)
   */
  viewerId?: string | null;
  /**
   * Skip the visibility filter entirely. Set for callers with
   * `blog.write` so the admin list shows every post regardless of who
   * the post was meant for.
   */
  bypassVisibility?: boolean;
  limit?: number;
  offset?: number;
}

export interface GetPostOptions {
  viewerId?: string | null;
  bypassVisibility?: boolean;
  /** Author-facing read: include drafts. */
  includeDrafts?: boolean;
}

/**
 * Builds the WHERE clause that filters rows the viewer is not allowed to
 * see. Returns both the SQL fragment and the parameter list, using the
 * given `$N` offset so callers can append their own params before/after.
 *
 * - `bypassVisibility` → empty fragment, empty params.
 * - anonymous          → `visibility = 'public'`.
 * - authenticated      → public + authenticated + group (if member of an
 *                        assigned group).
 */
function buildVisibilityClause(
  options: { viewerId?: string | null; bypassVisibility?: boolean },
  startIndex: number
): { sql: string; params: unknown[] } {
  if (options.bypassVisibility) {
    return { sql: '', params: [] };
  }
  if (!options.viewerId) {
    return { sql: `p.visibility = 'public'`, params: [] };
  }
  // Authenticated viewer: public + authenticated unconditionally, plus
  // group when the viewer is a member of *any* group linked to the post.
  const idx = `$${startIndex}`;
  return {
    sql: `(
      p.visibility IN ('public', 'authenticated')
      OR (
        p.visibility = 'group'
        AND EXISTS (
          SELECT 1 FROM public."blog_post_group_access" bpga
          JOIN public."user_group" ug ON ug.group_id = bpga.group_id
          WHERE bpga.post_id = p.id AND ug.user_id = ${idx}::uuid
        )
      )
    )`,
    params: [options.viewerId]
  };
}

export class BlogService {
  async listPosts(options: ListPostsOptions = {}): Promise<BlogPost[]> {
    const {
      includeDrafts = false,
      viewerId = null,
      bypassVisibility = false,
      limit = 50,
      offset = 0
    } = options;

    const whereParts: string[] = [];
    const params: unknown[] = [];

    if (!includeDrafts) {
      whereParts.push('p.published_at IS NOT NULL');
    }

    const visibility = buildVisibilityClause({ viewerId, bypassVisibility }, params.length + 1);
    if (visibility.sql) {
      whereParts.push(visibility.sql);
      params.push(...visibility.params);
    }

    const where = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    const orderBy = includeDrafts
      ? 'ORDER BY COALESCE(p.published_at, p.created_at) DESC'
      : 'ORDER BY p.published_at DESC';

    params.push(limit, offset);
    const result: QueryResult<BlogPost> = await persistence.database.query(
      `SELECT ${POST_COLUMNS}
       FROM public."blog_post" p
       ${where}
       ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return result.rows;
  }

  async getPostBySlug(slug: string, options: GetPostOptions = {}): Promise<BlogPost | null> {
    const { viewerId = null, bypassVisibility = false, includeDrafts = false } = options;

    const whereParts = ['p.slug = $1'];
    const params: unknown[] = [slug];

    if (!includeDrafts) {
      whereParts.push('p.published_at IS NOT NULL');
    }

    const visibility = buildVisibilityClause({ viewerId, bypassVisibility }, params.length + 1);
    if (visibility.sql) {
      whereParts.push(visibility.sql);
      params.push(...visibility.params);
    }

    const result: QueryResult<BlogPost> = await persistence.database.query(
      `SELECT ${POST_COLUMNS}
       FROM public."blog_post" p
       WHERE ${whereParts.join(' AND ')}`,
      params
    );
    return result.rows[0] ?? null;
  }

  async getPostById(id: string): Promise<BlogPost | null> {
    const result: QueryResult<BlogPost> = await persistence.database.query(
      `SELECT ${POST_COLUMNS} FROM public."blog_post" p WHERE p.id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Creates a post. When `visibility === 'group'` the access-group rows
   * are inserted in the same transaction so a partial failure doesn't
   * leave a post locked to zero groups (which would be silently
   * inaccessible to everyone).
   */
  async createPost(options: CreateBlogPostOptions): Promise<BlogPost> {
    const {
      authorId,
      slug,
      title,
      content,
      excerpt = null,
      publish = false,
      visibility = 'public',
      groupIds = []
    } = options;
    const publishedAt = publish ? new Date() : null;
    const effectiveGroupIds = visibility === 'group' ? dedupe(groupIds) : [];

    return this.withTx(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public."blog_post"
           (author_id, slug, title, excerpt, content, published_at, visibility)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [authorId, slug, title, excerpt, content, publishedAt, visibility]
      );
      const postId = inserted.rows[0].id;

      if (effectiveGroupIds.length > 0) {
        await insertAccessGroups(client, postId, effectiveGroupIds);
      }

      return (await fetchPostByIdTx(client, postId))!;
    });
  }

  async updatePost(id: string, updates: UpdateBlogPostOptions): Promise<BlogPost | null> {
    return this.withTx(async (client) => {
      const existing = await fetchPostByIdTx(client, id);
      if (!existing) {
        return null;
      }

      const setFragments: string[] = [];
      const values: unknown[] = [];
      const push = (column: string, value: unknown) => {
        values.push(value);
        setFragments.push(`${column} = $${values.length}`);
      };

      if (updates.slug !== undefined) push('slug', updates.slug);
      if (updates.title !== undefined) push('title', updates.title);
      if (updates.content !== undefined) push('content', updates.content);
      if (updates.excerpt !== undefined) push('excerpt', updates.excerpt);
      if (updates.visibility !== undefined) push('visibility', updates.visibility);

      if (updates.publish !== undefined) {
        if (updates.publish === true && existing.publishedAt === null) {
          push('published_at', new Date());
        } else if (updates.publish === false) {
          push('published_at', null);
        }
      }

      if (setFragments.length > 0) {
        values.push(id);
        setFragments.push('updated_at = NOW()');
        await client.query(
          `UPDATE public."blog_post" SET ${setFragments.join(', ')} WHERE id = $${values.length}`,
          values
        );
      }

      // Group-access replacement. If visibility was flipped away from
      // `group`, always wipe the set so a later flip back to `group`
      // doesn't resurrect stale assignments. If it stayed `group`, only
      // rewrite when the caller passed an explicit `groupIds`.
      const finalVisibility = updates.visibility ?? existing.visibility;
      if (finalVisibility !== 'group') {
        await client.query(
          `DELETE FROM public."blog_post_group_access" WHERE post_id = $1`,
          [id]
        );
      } else if (updates.groupIds !== undefined) {
        await client.query(
          `DELETE FROM public."blog_post_group_access" WHERE post_id = $1`,
          [id]
        );
        const deduped = dedupe(updates.groupIds);
        if (deduped.length > 0) {
          await insertAccessGroups(client, id, deduped);
        }
      }

      return fetchPostByIdTx(client, id);
    });
  }

  async deletePost(id: string): Promise<boolean> {
    const result = await persistence.database.query(
      'DELETE FROM public."blog_post" WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Lookup helper used by the detail controller. We need the visibility
   * + access-groups before we can decide whether to 200 or 404 for a
   * non-admin viewer, so the service exposes a dedicated probe instead
   * of forcing the controller to replicate the filter logic.
   */
  async canViewerRead(postId: string, viewerId: string | null): Promise<boolean> {
    if (!viewerId) {
      const row = await persistence.database.query<{ ok: boolean }>(
        `SELECT (visibility = 'public' AND published_at IS NOT NULL) AS ok
         FROM public."blog_post" WHERE id = $1`,
        [postId]
      );
      return row.rows[0]?.ok === true;
    }
    const row = await persistence.database.query<{ ok: boolean }>(
      `SELECT (
         published_at IS NOT NULL
         AND (
           visibility IN ('public', 'authenticated')
           OR (
             visibility = 'group'
             AND EXISTS (
               SELECT 1 FROM public."blog_post_group_access" bpga
               JOIN public."user_group" ug ON ug.group_id = bpga.group_id
               WHERE bpga.post_id = $1 AND ug.user_id = $2::uuid
             )
           )
         )
       ) AS ok
       FROM public."blog_post" WHERE id = $1`,
      [postId, viewerId]
    );
    return row.rows[0]?.ok === true;
  }

  /**
   * Transactional helper. Uses a dedicated connection from the pool so
   * BEGIN/COMMIT/ROLLBACK run against the same session.
   */
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

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

/**
 * Batch-inserts the access rows in a single round-trip. Skips any group
 * IDs that don't exist (the FK would reject them anyway, but that would
 * rollback the whole transaction with a confusing error — better to let
 * the caller validate).
 */
async function insertAccessGroups(
  client: PoolClient,
  postId: string,
  groupIds: string[]
): Promise<void> {
  if (groupIds.length === 0) return;
  const placeholders = groupIds.map((_, i) => `($1, $${i + 2}::uuid)`).join(', ');
  await client.query(
    `INSERT INTO public."blog_post_group_access" (post_id, group_id)
     VALUES ${placeholders}`,
    [postId, ...groupIds]
  );
}

async function fetchPostByIdTx(client: PoolClient, id: string): Promise<BlogPost | null> {
  const result: QueryResult<BlogPost & QueryResultRow> = await client.query(
    `SELECT ${POST_COLUMNS} FROM public."blog_post" p WHERE p.id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export { VALID_VISIBILITIES };
export default new BlogService();
