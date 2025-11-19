import { Request, Response, NextFunction } from 'express';
import userService from '../services/userService.js';
import { AppError, asyncHandler } from '../middleware/index.js';
import { serializeUser } from '../utils/userSerializer.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value: string | undefined): boolean => {
  if (!value) {
    return false;
  }

  return uuidPattern.test(value);
};

const extractRequesterContext = (req: Request) => {
  const payload = req.auth?.payload as { sub?: unknown; scopes?: unknown } | undefined;
  const scopes = Array.isArray(payload?.scopes)
    ? (payload?.scopes as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
  const userId = typeof payload?.sub === 'string' ? payload.sub : null;

  return { scopes, userId };
};

export class UserController {
  getAllUsers = asyncHandler(async (req: Request, res: Response) => {
    const { scopes, userId } = extractRequesterContext(req);
    const users = await userService.getAllUsers();
    const response = users.map((user) => serializeUser(user, { scopes, isSelf: user.id === userId }));

    res.status(200).json(response);
  });

  getUserById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { scopes, userId: requesterId } = extractRequesterContext(req);
    const { id } = req.params;

    if (!isUuid(id)) {
      return next(AppError.badRequest('Invalid user ID'));
    }

    const user = await userService.getUserById(id);

    if (!user) {
      return next(AppError.notFound('User not found'));
    }

    res.status(200).json(serializeUser(user, { scopes, isSelf: user.id === requesterId }));
  });

  createUser = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { scopes, userId: requesterId } = extractRequesterContext(req);
    const { username, displayName, email, avatarUrl, profileUrl } = req.body;

    if (!username) {
      return next(AppError.badRequest('Username is required.'));
    }

    const user = await userService.createUser({ username, displayName, email, avatarUrl, profileUrl });

    res.status(201).json(serializeUser(user, { scopes, isSelf: user.id === requesterId }));
  });

  updateUser = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { scopes, userId: requesterId } = extractRequesterContext(req);
    const { id } = req.params;
    const { username, displayName, email, avatarUrl, profileUrl } = req.body;

    if (!isUuid(id)) {
      return next(AppError.badRequest('Invalid user ID'));
    }

    if (!username && displayName === undefined && email === undefined && avatarUrl === undefined && profileUrl === undefined) {
      return next(AppError.badRequest('At least one field (username, displayName, email, avatarUrl, profileUrl) must be provided.'));
    }

    const user = await userService.updateUser(id, { username, displayName, email, avatarUrl, profileUrl });

    if (!user) {
      return next(AppError.notFound('User not found'));
    }

    res.status(200).json(serializeUser(user, { scopes, isSelf: user.id === requesterId }));
  });

  deleteUser = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      return next(AppError.badRequest('Invalid user ID'));
    }

    const deleted = await userService.deleteUser(id);
    
    if (!deleted) {
      return next(AppError.notFound('User not found'));
    }

    res.status(204).send();
  });

  getMe = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { scopes, userId } = extractRequesterContext(req);

    if (!userId) {
      return next(AppError.badRequest('Authenticated user is not available.'));
    }

    const user = await userService.getUserById(userId);

    if (!user) {
      return next(AppError.notFound('Authenticated user not found.'));
    }

    res.status(200).json(serializeUser(user, { scopes, isSelf: true }));
  });
}

export default new UserController();
