import { Request, Response, NextFunction } from 'express';
import blogService from '../services/blog.js';
import userService from '../services/user.js';
import AppError from '../services/error.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/;

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

const listPosts = async (req: Request, res: Response) => {
  const author = await isAuthor(req);
  const includeDrafts = author && req.query.drafts === 'true';
  const limit = Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
  const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  const posts = await blogService.listPosts({ includeDrafts, limit, offset });
  res.status(200).json(posts);
};

const getPostBySlug = async (req: Request<{ slug: string }>, res: Response, next: NextFunction) => {
  const { slug } = req.params;
  const includeDrafts = await isAuthor(req);
  const post = await blogService.getPostBySlug(slug, includeDrafts);
  if (!post) {
    return next(AppError.notFound('Post not found', 'POST_NOT_FOUND'));
  }
  return res.status(200).json(post);
};

const createPost = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.userId) {
    return next(AppError.unauthorized('No authenticated user.'));
  }

  const { slug, title, content, excerpt, publish } = req.body ?? {};

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

  const existing = await blogService.getPostBySlug(slug, true);
  if (existing) {
    return next(AppError.conflict('A post with this slug already exists.', 'SLUG_TAKEN'));
  }

  const post = await blogService.createPost({
    authorId: req.userId,
    slug,
    title: title.trim(),
    content,
    excerpt: excerpt ?? null,
    publish: publish === true
  });
  return res.status(201).json(post);
};

const updatePost = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const { slug, title, content, excerpt, publish } = req.body ?? {};

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

  const post = await blogService.updatePost(id, {
    slug,
    title: typeof title === 'string' ? title.trim() : undefined,
    content,
    excerpt,
    publish
  });
  if (!post) {
    return next(AppError.notFound('Post not found', 'POST_NOT_FOUND'));
  }
  return res.status(200).json(post);
};

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
