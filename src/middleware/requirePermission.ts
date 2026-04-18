import { Request, Response, NextFunction } from 'express';
import userService from '../services/user.js';
import AppError from '../services/error.js';

/**
 * Returns an Express middleware that verifies the authenticated user holds
 * the given permission. Must run AFTER `system.authHandler`, which sets
 * `req.userId`.
 *
 * On success it caches the permission list on `res.locals.permissions` so
 * subsequent middleware/handlers don't have to re-query the DB.
 */
export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return next(AppError.unauthorized('Authentication required.'));
    }

    const permissions = await userService.getPermissions(req.userId);
    if (!permissions.includes(permission)) {
      return next(AppError.unauthorized(`Missing permission: ${permission}`, 'FORBIDDEN'));
    }

    res.locals.permissions = permissions;
    return next();
  };
}

export default requirePermission;
