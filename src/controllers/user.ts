import { Request, Response, NextFunction } from 'express';
import { user, error } from '../services';
import type { SocialLinkInput } from '../services/user.js';

const DISPLAY_NAME_MAX = 100;
const SOCIAL_LABEL_MAX = 60;
const SOCIAL_URL_MAX = 2048;
const SOCIAL_LINKS_MAX = 12;

/**
 * Lightweight URL validator. We only accept http(s) to avoid dumping
 * javascript:/data: URIs into the profile page where someone else will
 * eventually render them. Length-capped so we don't have to worry about
 * the url varchar blowing up.
 */
function isValidHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > SOCIAL_URL_MAX) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeSocialLinks(raw: unknown): { links: SocialLinkInput[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: '`socialLinks` must be an array.' };
  }
  if (raw.length > SOCIAL_LINKS_MAX) {
    return { error: `Maximal ${SOCIAL_LINKS_MAX} Social-Links.` };
  }
  const links: SocialLinkInput[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') {
      return { error: `socialLinks[${index}] muss ein Objekt sein.` };
    }
    const { label, url } = entry as { label?: unknown; url?: unknown };
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > SOCIAL_LABEL_MAX) {
      return { error: `socialLinks[${index}].label muss 1–${SOCIAL_LABEL_MAX} Zeichen lang sein.` };
    }
    if (typeof url !== 'string' || !isValidHttpUrl(url)) {
      return { error: `socialLinks[${index}].url muss eine gültige http(s)-URL sein.` };
    }
    links.push({ label: label.trim(), url: url.trim() });
  }
  return { links };
}

const getAllUsers = async (res: Response) => {
  const users = await user.getAllUsers();
  return res.status(200).json(users);
};

const getUserById = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;

  const data = await user.getUserById(id);

  if (!data) {
    return next(error.notFound('User not found'));
  }

  return res.status(200).json(data);
};

const getMe = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.userId) {
    return next(error.unauthorized('No authenticated user.'));
  }

  const data = await user.getUserById(req.userId);

  if (!data) {
    return next(error.notFound('Authenticated user not found.'));
  }

  const [permissions, socialLinks] = await Promise.all([
    user.getPermissions(req.userId),
    user.listSocialLinks(req.userId)
  ]);
  return res.status(200).json({ ...data, permissions, socialLinks });
};

/**
 * Self-update. Deliberately narrower than the admin `PUT /admin/users/:id`
 * endpoint: users can only change their displayName, avatarUrl, and
 * socialLinks here. `name` (login handle) and `email` remain admin-only
 * because both affect identity / matching.
 */
const updateMe = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.userId) {
    return next(error.unauthorized('No authenticated user.'));
  }

  const { displayName, avatarUrl, socialLinks } = req.body ?? {};

  if (displayName !== undefined && displayName !== null) {
    if (typeof displayName !== 'string' || displayName.length > DISPLAY_NAME_MAX) {
      return next(error.badRequest(`displayName muss ein String ≤ ${DISPLAY_NAME_MAX} Zeichen sein.`, 'BAD_DISPLAY_NAME'));
    }
  }

  if (avatarUrl !== undefined && avatarUrl !== null && avatarUrl !== '') {
    if (typeof avatarUrl !== 'string' || !isValidHttpUrl(avatarUrl)) {
      return next(error.badRequest('avatarUrl muss eine gültige http(s)-URL sein.', 'BAD_AVATAR_URL'));
    }
  }

  let normalizedLinks: SocialLinkInput[] | undefined;
  if (socialLinks !== undefined) {
    const result = normalizeSocialLinks(socialLinks);
    if ('error' in result) {
      return next(error.badRequest(result.error, 'BAD_SOCIAL_LINKS'));
    }
    normalizedLinks = result.links;
  }

  const updated = await user.updateUser(req.userId, {
    displayName: displayName === '' ? null : displayName,
    avatarUrl: avatarUrl === '' ? null : avatarUrl
  });

  if (!updated) {
    return next(error.notFound('User not found.'));
  }

  if (normalizedLinks !== undefined) {
    await user.replaceSocialLinks(req.userId, normalizedLinks);
  }

  const [permissions, links] = await Promise.all([
    user.getPermissions(req.userId),
    user.listSocialLinks(req.userId)
  ]);

  return res.status(200).json({ ...updated, permissions, socialLinks: links });
};

const createUser = async (req: Request, res: Response, next: NextFunction) => {
  const { name } = req.body;

  if (!name) {
    return next(error.badRequest('Name is required'));
  }

  const data = await user.createUser({
    name
  });

  return res.status(201).json(data);
};

const updateUser = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const { name, displayName, email } = req.body;

  if (!name && displayName === undefined && email === undefined) {
    return next(error.badRequest('At least one field (name, displayName, email) must be provided'));
  }

  const data = await user.updateUser(id, {
    name,
    displayName,
    email
  });

  if (!data) {
    return next(error.notFound('User not found'));
  }

  return res.status(200).json(data);
};

const deleteUser = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const deleted = await user.deleteUser(id);

  if (!deleted) {
    return next(error.notFound('User not found'));
  }

  return res.status(204).send();
};

const nukeMePlease = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.userId) {
    return next(error.unauthorized('No authenticated user.'));
  }

  console.info(`User ${req.userId} requested nukeMePlease lol`);
  await user.deleteUser(req.userId);
  return res.status(204).send();
};

export default {
  getAllUsers,
  getUserById,
  getMe,
  updateMe,
  createUser,
  updateUser,
  deleteUser,
  nukeMePlease
};
