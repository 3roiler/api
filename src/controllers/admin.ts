import { Request, Response, NextFunction } from 'express';
import userService from '../services/user.js';
import { PERMISSIONS, isKnownPermission } from '../services/permissions.js';
import AppError from '../services/error.js';

/**
 * Admin-only controller for managing user permissions. Every route mounted
 * through this file must go through `requirePermission('admin.manage')` in
 * the route file — the handlers here assume that gate has already run.
 */

const listUsers = async (_req: Request, res: Response) => {
  const users = await userService.getAllUsersWithPermissions();
  res.status(200).json(users);
};

const listPermissions = async (_req: Request, res: Response) => {
  res.status(200).json(PERMISSIONS);
};

const grantPermission = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
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

const revokePermission = async (
  req: Request<{ id: string; permission: string }>,
  res: Response,
  next: NextFunction
) => {
  const { id, permission } = req.params;

  // Guardrail: don't let an admin revoke their own `admin.manage` — would
  // lock them out of this UI (and every other admin does the same guard
  // so there's always at least one path back in).
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

export default {
  listUsers,
  listPermissions,
  grantPermission,
  revokePermission
};
