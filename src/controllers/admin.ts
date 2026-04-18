import { Request, Response, NextFunction } from 'express';
import userService from '../services/user.js';
import groupService from '../services/group.js';
import { PERMISSIONS, isKnownPermission } from '../services/permissions.js';
import AppError from '../services/error.js';

/**
 * Admin-only controller for managing users, groups and their permissions.
 * Every route mounted through this file must go through
 * `requirePermission('admin.manage')` in the route file — the handlers
 * here assume that gate has already run.
 */

// Group keys are also used in URLs/joins, so keep them URL-safe. Display
// names are free-form but length-capped to stay within the varchar(100).
const GROUP_KEY_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const DISPLAY_NAME_MAX = 100;
const EMAIL_MAX = 320;
const NAME_MAX = 100;

/**
 * Lightweight email validator without regex backtracking. Requires exactly
 * one `@`, a non-empty local part, and a domain with at least one dot in
 * a non-edge position. Done with string ops on purpose so static analysis
 * tools don't flag a `[^\s@]+@[^\s@]+\.[^\s@]+` style pattern as ReDoS.
 */
function isValidEmail(value: string): boolean {
  if (value.length === 0 || value.length > EMAIL_MAX) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

// ─── Users ──────────────────────────────────────────────────────────────

const listUsers = async (_req: Request, res: Response) => {
  const users = await userService.getAllUsersWithPermissions();
  res.status(200).json(users);
};

const updateUser = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const { displayName, email, name } = req.body ?? {};

  if (displayName !== undefined && displayName !== null &&
      (typeof displayName !== 'string' || displayName.length > DISPLAY_NAME_MAX)) {
    return next(AppError.badRequest(`displayName must be a string ≤ ${DISPLAY_NAME_MAX} chars.`, 'BAD_DISPLAY_NAME'));
  }
  if (email !== undefined && email !== null && email !== '' &&
      (typeof email !== 'string' || !isValidEmail(email))) {
    return next(AppError.badRequest('email must be a valid address.', 'BAD_EMAIL'));
  }
  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0 || name.length > NAME_MAX)) {
    return next(AppError.badRequest(`name must be a non-empty string ≤ ${NAME_MAX} chars.`, 'BAD_NAME'));
  }

  const target = await userService.getUserById(id);
  if (!target) {
    return next(AppError.notFound('User not found.', 'USER_NOT_FOUND'));
  }

  const updated = await userService.updateUser(id, {
    name,
    displayName: displayName === '' ? null : displayName,
    email: email === '' ? null : email
  });
  if (!updated) {
    return next(AppError.notFound('User not found.', 'USER_NOT_FOUND'));
  }
  return res.status(200).json(updated);
};

const deleteUser = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;

  // Guardrail: deleting yourself via the admin UI would log you out of
  // everything and make the session token refer to a non-existent user
  // until it expires. Always force a different admin to do it.
  if (req.userId === id) {
    return next(AppError.badRequest('You cannot delete your own account here. Use `/user/nuke` instead.', 'SELF_DELETE_FORBIDDEN'));
  }

  const target = await userService.getUserById(id);
  if (!target) {
    return next(AppError.notFound('User not found.', 'USER_NOT_FOUND'));
  }

  await userService.deleteUser(id);
  return res.status(204).send();
};

// ─── Permissions (catalog + user-level grant/revoke) ────────────────────

const listPermissions = async (_req: Request, res: Response) => {
  res.status(200).json(PERMISSIONS);
};

const grantUserPermission = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const { permission } = req.body ?? {};

  if (typeof permission !== 'string' || permission.trim().length === 0) {
    return next(AppError.badRequest('`permission` is required.', 'BAD_PERMISSION'));
  }
  if (!isKnownPermission(permission)) {
    return next(AppError.badRequest(`Unknown permission: ${permission}`, 'UNKNOWN_PERMISSION'));
  }

  const target = await userService.getUserById(id);
  if (!target) {
    return next(AppError.notFound('User not found.', 'USER_NOT_FOUND'));
  }

  await userService.grantPermission(id, permission);
  return res.status(204).send();
};

const revokeUserPermission = async (
  req: Request<{ id: string; permission: string }>,
  res: Response,
  next: NextFunction
) => {
  const { id, permission } = req.params;

  if (permission === 'admin.manage' && req.userId === id) {
    return next(AppError.badRequest(
      'You cannot revoke admin.manage from yourself.',
      'SELF_REVOKE_FORBIDDEN'
    ));
  }

  const target = await userService.getUserById(id);
  if (!target) {
    return next(AppError.notFound('User not found.', 'USER_NOT_FOUND'));
  }

  const removed = await userService.revokePermission(id, permission);
  if (!removed) {
    return next(AppError.notFound(
      'Permission was not directly granted to this user (may be inherited from a group).',
      'GRANT_NOT_FOUND'
    ));
  }
  return res.status(204).send();
};

// ─── Groups ─────────────────────────────────────────────────────────────

const listGroups = async (_req: Request, res: Response) => {
  const groups = await groupService.listGroups();
  res.status(200).json(groups);
};

const getGroup = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const group = await groupService.getGroupDetail(id);
  if (!group) {
    return next(AppError.notFound('Group not found.', 'GROUP_NOT_FOUND'));
  }
  return res.status(200).json(group);
};

const createGroup = async (req: Request, res: Response, next: NextFunction) => {
  const { key, displayName } = req.body ?? {};

  if (typeof key !== 'string' || !GROUP_KEY_RE.test(key)) {
    return next(AppError.badRequest(
      'Group key must be 3–40 chars, lowercase letters/digits/hyphens, start and end with an alphanumeric.',
      'BAD_GROUP_KEY'
    ));
  }
  if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > DISPLAY_NAME_MAX) {
    return next(AppError.badRequest(`displayName must be a non-empty string ≤ ${DISPLAY_NAME_MAX} chars.`, 'BAD_DISPLAY_NAME'));
  }

  const existing = await groupService.getGroupByKey(key);
  if (existing) {
    return next(AppError.conflict('A group with this key already exists.', 'KEY_TAKEN'));
  }

  const group = await groupService.createGroup(key, displayName.trim());
  return res.status(201).json(group);
};

const updateGroup = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const { key, displayName } = req.body ?? {};

  if (key !== undefined && (typeof key !== 'string' || !GROUP_KEY_RE.test(key))) {
    return next(AppError.badRequest(
      'Group key must be 3–40 chars, lowercase letters/digits/hyphens.',
      'BAD_GROUP_KEY'
    ));
  }
  if (displayName !== undefined &&
      (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > DISPLAY_NAME_MAX)) {
    return next(AppError.badRequest(`displayName must be a non-empty string ≤ ${DISPLAY_NAME_MAX} chars.`, 'BAD_DISPLAY_NAME'));
  }

  const existing = await groupService.getGroupById(id);
  if (!existing) {
    return next(AppError.notFound('Group not found.', 'GROUP_NOT_FOUND'));
  }
  if (key !== undefined && key !== existing.key) {
    const byKey = await groupService.getGroupByKey(key);
    if (byKey) {
      return next(AppError.conflict('A group with this key already exists.', 'KEY_TAKEN'));
    }
  }

  const updated = await groupService.updateGroup(id, {
    key,
    displayName: typeof displayName === 'string' ? displayName.trim() : undefined
  });
  return res.status(200).json(updated);
};

const deleteGroup = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const existing = await groupService.getGroupById(id);
  if (!existing) {
    return next(AppError.notFound('Group not found.', 'GROUP_NOT_FOUND'));
  }
  await groupService.deleteGroup(id);
  return res.status(204).send();
};

// ─── Group membership ───────────────────────────────────────────────────

const addGroupMember = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const { userId } = req.body ?? {};

  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return next(AppError.badRequest('`userId` is required.', 'BAD_USER_ID'));
  }

  const group = await groupService.getGroupById(id);
  if (!group) {
    return next(AppError.notFound('Group not found.', 'GROUP_NOT_FOUND'));
  }
  const user = await userService.getUserById(userId);
  if (!user) {
    return next(AppError.notFound('User not found.', 'USER_NOT_FOUND'));
  }

  await groupService.addMember(id, userId);
  return res.status(204).send();
};

const removeGroupMember = async (
  req: Request<{ id: string; userId: string }>,
  res: Response,
  next: NextFunction
) => {
  const { id, userId } = req.params;
  const group = await groupService.getGroupById(id);
  if (!group) {
    return next(AppError.notFound('Group not found.', 'GROUP_NOT_FOUND'));
  }

  const removed = await groupService.removeMember(id, userId);
  if (!removed) {
    return next(AppError.notFound('User is not a member of this group.', 'NOT_A_MEMBER'));
  }
  return res.status(204).send();
};

// ─── Group permissions ──────────────────────────────────────────────────

const grantGroupPermission = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const { permission } = req.body ?? {};

  if (typeof permission !== 'string' || permission.trim().length === 0) {
    return next(AppError.badRequest('`permission` is required.', 'BAD_PERMISSION'));
  }
  if (!isKnownPermission(permission)) {
    return next(AppError.badRequest(`Unknown permission: ${permission}`, 'UNKNOWN_PERMISSION'));
  }

  const group = await groupService.getGroupById(id);
  if (!group) {
    return next(AppError.notFound('Group not found.', 'GROUP_NOT_FOUND'));
  }

  await groupService.grantPermission(id, permission);
  return res.status(204).send();
};

const revokeGroupPermission = async (
  req: Request<{ id: string; permission: string }>,
  res: Response,
  next: NextFunction
) => {
  const { id, permission } = req.params;

  const group = await groupService.getGroupById(id);
  if (!group) {
    return next(AppError.notFound('Group not found.', 'GROUP_NOT_FOUND'));
  }

  const removed = await groupService.revokePermission(id, permission);
  if (!removed) {
    return next(AppError.notFound('Permission was not granted to this group.', 'GRANT_NOT_FOUND'));
  }
  return res.status(204).send();
};

export default {
  // Users
  listUsers,
  updateUser,
  deleteUser,
  // Permissions catalog + user-level
  listPermissions,
  grantUserPermission,
  revokeUserPermission,
  // Groups
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  // Membership
  addGroupMember,
  removeGroupMember,
  // Group-level permissions
  grantGroupPermission,
  revokeGroupPermission
};
