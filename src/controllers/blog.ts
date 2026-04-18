import { Request, Response, NextFunction } from 'express';
import blogService, { VALID_VISIBILITIES } from '../services/blog.js';
import userService from '../services/user.js';
import AppError from '../services/error.js';
import type { BlogPostVisibility } from '../models/index.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Author check for the public GET routes. `requirePermission` is not in the
 * chain there (they're public), so we can't rely on `res.locals.permissions`.
 * `optionalAuthHandler` may have set `req.userId`; if it did, pull the live
 * permission list. Anonymous visitors short-circuit to `false`.
 */
async function isAuthor(req: Request): Promise<boolean> {
  if (req.res?.locals.permissions) {
    return (req.res.locals.permissions as string[]).includes('blog.write');
  }
  if (!req.userId) return false;
  const permissions = await userService.getPermissions(req.userId);
  return permissions.includes('blog.write');
}

function validateSlug(slug: unknown, next: NextFunction): slug is string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    next(AppError.badRequest('Slug must be lowercase letters, digits and hyphens (3–120 chars).', 'BAD_SLUG'));
    return false;
  }
  return true;
}

/**
 * Validates a `{ visibility, groupIds }` pair out of the request body.
 * Returns `undefined` on validation error (and pushes the error into
 * `next`), otherwise a normalised tuple.
 *
 * - `visibility` must be one of the three known values when present.
 * - `groupIds` is only allowed (and required non-empty) when visibility
 *   is `group` — otherwise a supplied list is rejected so a UI mistake
 *   can't silently link groups to a public post.
 * - Each group ID is UUID-shape-checked client-side; the service call
 *   will surface FK errors as 400 if a UUID references a non-existent
 *   group.
 */
function validateVisibility(
  body: Record<string, unknown>,
  next: NextFunction,
  { allowUndefined }: { allowUndefined: boolean }
): { visibility?: BlogPostVisibility; groupIds?: string[] } | undefined {
  const { visibility, groupIds } = body;

  if (visibility === undefined) {
    if (!allowUndefined) {
      next(AppError.badRequest('`visibility` is required.', 'BAD_VISIBILITY'));
      return undefined;
    }
    // On update: nothing to validate for visibility itself, but a stray
    // `groupIds` without a `visibility` flip is allowed as long as the
    // current post already is in `group` mode. We can't check that here
    // without a DB round-trip, so we just forward and let the service
    // wipe the list if the post isn't group-scoped.
    if (groupIds !== undefined && !Array.isArray(groupIds)) {
      next(AppError.badRequest('`groupIds` must be an array of UUIDs.', 'BAD_GROUP_IDS'));
      return undefined;
    }
    if (Array.isArray(groupIds) && !groupIds.every((g) => typeof g === 'string' && UUID_RE.test(g))) {
      next(AppError.badRequest('`groupIds` must be an array of UUIDs.', 'BAD_GROUP_IDS'));
      return undefined;
    }
    return { groupIds: groupIds as string[] | undefined };
  }

  if (typeof visibility !== 'string' || !VALID_VISIBILITIES.includes(visibility as BlogPostVisibility)) {
    next(AppError.badRequest(
      `\`visibility\` must be one of: ${VALID_VISIBILITIES.join(', ')}.`,
      'BAD_VISIBILITY'
    ));
    return undefined;
  }

  if (visibility === 'group') {
    if (!Array.isArray(groupIds) || groupIds.length === 0) {
      next(AppError.badRequest(
        '`groupIds` must be a non-empty array when visibility is `group`.',
        'BAD_GROUP_IDS'
      ));
      return undefined;
    }
    if (!groupIds.every((g) => typeof g === 'string' && UUID_RE.test(g))) {
      next(AppError.badRequest('`groupIds` must contain UUIDs only.', 'BAD_GROUP_IDS'));
      return undefined;
    }
    return { visibility: 'group', groupIds: groupIds as string[] };
  }

  // public / authenticated: reject any supplied groupIds — they'd be
  // dead weight and hint at a UI/API contract mismatch worth surfacing.
  if (groupIds !== undefined && (!Array.isArray(groupIds) || groupIds.length > 0)) {
    next(AppError.badRequest(
      '`groupIds` is only allowed when visibility is `group`.',
      'BAD_GROUP_IDS'
    ));
    return undefined;
  }
  return { visibility: visibility as BlogPostVisibility, groupIds: [] };
}

const listPosts = async (req: Request, res: Response) => {
  const author = await isAuthor(req);
  const includeDrafts = author && req.query.drafts === 'true';
  const limit = Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
  const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  const posts = await blogService.listPosts({
    includeDrafts,
    limit,
    offset,
    viewerId: req.userId ?? null,
    // Authors see everything, including posts not intended for them —
    // otherwise they couldn't edit a post they just published to a
    // group they aren't part of.
    bypassVisibility: author
  });
  res.status(200).json(posts);
};

const getPostBySlug = async (req: Request<{ slug: string }>, res: Response, next: NextFunction) => {
  const { slug } = req.params;
  const author = await isAuthor(req);
  const post = await blogService.getPostBySlug(slug, {
    viewerId: req.userId ?? null,
    bypassVisibility: author,
    includeDrafts: author
  });
  if (!post) {
    return next(AppError.notFound('Post not found', 'POST_NOT_FOUND'));
  }
  return res.status(200).json(post);
};

const createPost = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.userId) {
    return next(AppError.unauthorized('No authenticated user.'));
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const { slug, title, content, excerpt, publish } = body;

  if (!validateSlug(slug, next)) return;
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
    return next(AppError.badRequest('Title is required (1–200 chars).', 'BAD_TITLE'));
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    return next(AppError.badRequest('Content is required.', 'BAD_CONTENT'));
  }
  if (excerpt !== undefined && excerpt !== null && (typeof excerpt !== 'string' || excerpt.length > 400)) {
    return next(AppError.badRequest('Excerpt must be a string ≤ 400 chars.', 'BAD_EXCERPT'));
  }

  // Visibility defaults to `public` if the client omits it, so existing
  // create-post callers keep working without changes. Passing a value
  // though goes through full validation.
  const visibilityResult = validateVisibility(body, next, { allowUndefined: true });
  if (visibilityResult === undefined) return;

  const existing = await blogService.getPostBySlug(slug as string, { bypassVisibility: true, includeDrafts: true });
  if (existing) {
    return next(AppError.conflict('A post with this slug already exists.', 'SLUG_TAKEN'));
  }

  try {
    const post = await blogService.createPost({
      authorId: req.userId,
      slug: slug as string,
      title: title.trim(),
      content,
      excerpt: (excerpt as string | null | undefined) ?? null,
      publish: publish === true,
      visibility: visibilityResult.visibility ?? 'public',
      groupIds: visibilityResult.groupIds ?? []
    });
    return res.status(201).json(post);
  } catch (err) {
    return next(mapGroupFkError(err));
  }
};

const updatePost = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { slug, title, content, excerpt, publish } = body;

  if (slug !== undefined && !validateSlug(slug, next)) return;
  if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0 || title.length > 200)) {
    return next(AppError.badRequest('Title must be 1–200 chars.', 'BAD_TITLE'));
  }
  if (content !== undefined && (typeof content !== 'string' || content.trim().length === 0)) {
    return next(AppError.badRequest('Content cannot be empty.', 'BAD_CONTENT'));
  }
  if (excerpt !== undefined && excerpt !== null && (typeof excerpt !== 'string' || excerpt.length > 400)) {
    return next(AppError.badRequest('Excerpt must be a string ≤ 400 chars.', 'BAD_EXCERPT'));
  }
  if (publish !== undefined && typeof publish !== 'boolean') {
    return next(AppError.badRequest('`publish` must be a boolean.', 'BAD_PUBLISH'));
  }

  const visibilityResult = validateVisibility(body, next, { allowUndefined: true });
  if (visibilityResult === undefined) return;

  try {
    const post = await blogService.updatePost(id, {
      slug: slug as string | undefined,
      title: typeof title === 'string' ? title.trim() : undefined,
      content: content as string | undefined,
      excerpt: excerpt as string | null | undefined,
      publish: publish as boolean | undefined,
      visibility: visibilityResult.visibility,
      groupIds: visibilityResult.groupIds
    });
    if (!post) {
      return next(AppError.notFound('Post not found', 'POST_NOT_FOUND'));
    }
    return res.status(200).json(post);
  } catch (err) {
    return next(mapGroupFkError(err));
  }
};

/**
 * Turns a Postgres FK-violation on `blog_post_group_access.group_id`
 * into a client-friendly 400 instead of bubbling up as 500.
 */
function mapGroupFkError(err: unknown): unknown {
  if (
    err instanceof Error &&
    'code' in err &&
    (err as { code?: string }).code === '23503' &&
    err.message.includes('blog_post_group_access')
  ) {
    return AppError.badRequest('One or more group IDs do not exist.', 'BAD_GROUP_IDS');
  }
  return err;
}

const deletePost = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const deleted = await blogService.deletePost(id);
  if (!deleted) {
    return next(AppError.notFound('Post not found', 'POST_NOT_FOUND'));
  }
  return res.status(204).send();
};

export default {
  listPosts,
  getPostBySlug,
  createPost,
  updatePost,
  deletePost
};
