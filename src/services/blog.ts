import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import type { BlogPost } from '../models/index.js';

const POST_COLUMNS = `
  id,
  author_id AS "authorId",
  slug,
  title,
  excerpt,
  content,
  published_at AS "publishedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export interface CreateBlogPostOptions {
  authorId: string;
  slug: string;
  title: string;
  content: string;
  excerpt?: string | null;
  publish?: boolean;
}

export interface UpdateBlogPostOptions {
  slug?: string;
  title?: string;
  content?: string;
  excerpt?: string | null;
  publish?: boolean | null;
}

export interface ListPostsOptions {
  includeDrafts?: boolean;
  limit?: number;
  offset?: number;
}

export class BlogService {
  async listPosts(options: ListPostsOptions = {}): Promise<BlogPost[]> {
    const { includeDrafts = false, limit = 50, offset = 0 } = options;
    const where = includeDrafts ? '' : 'WHERE published_at IS NOT NULL';
    const orderBy = includeDrafts
      ? 'ORDER BY COALESCE(published_at, created_at) DESC'
      : 'ORDER BY published_at DESC';

    const result: QueryResult<BlogPost> = await persistence.database.query(
      `SELECT ${POST_COLUMNS} FROM public."blog_post" ${where} ${orderBy} LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  }

  async getPostBySlug(slug: string, includeDrafts = false): Promise<BlogPost | null> {
    const result: QueryResult<BlogPost> = await persistence.database.query(
      `SELECT ${POST_COLUMNS}
       FROM public."blog_post"
       WHERE slug = $1 ${includeDrafts ? '' : 'AND published_at IS NOT NULL'}`,
      [slug]
    );
    return result.rows[0] ?? null;
  }

  async getPostById(id: string): Promise<BlogPost | null> {
    const result: QueryResult<BlogPost> = await persistence.database.query(
      `SELECT ${POST_COLUMNS} FROM public."blog_post" WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async createPost(options: CreateBlogPostOptions): Promise<BlogPost> {
    const { authorId, slug, title, content, excerpt = null, publish = false } = options;
    const publishedAt = publish ? new Date() : null;

    const result: QueryResult<BlogPost> = await persistence.database.query(
      `INSERT INTO public."blog_post" (author_id, slug, title, excerpt, content, published_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${POST_COLUMNS}`,
      [authorId, slug, title, excerpt, content, publishedAt]
    );
    return result.rows[0];
  }

  async updatePost(id: string, updates: UpdateBlogPostOptions): Promise<BlogPost | null> {
    const existing = await this.getPostById(id);
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

    if (updates.publish !== undefined) {
      if (updates.publish === true && existing.publishedAt === null) {
        push('published_at', new Date());
      } else if (updates.publish === false) {
        push('published_at', null);
      }
    }

    if (setFragments.length === 0) {
      return existing;
    }

    values.push(id);
    setFragments.push('updated_at = NOW()');

    const result: QueryResult<BlogPost> = await persistence.database.query(
      `UPDATE public."blog_post"
       SET ${setFragments.join(', ')}
       WHERE id = $${values.length}
       RETURNING ${POST_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  async deletePost(id: string): Promise<boolean> {
    const result = await persistence.database.query(
      'DELETE FROM public."blog_post" WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export default new BlogService();
