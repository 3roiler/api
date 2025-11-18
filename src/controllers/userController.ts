import { Request, Response, NextFunction } from 'express';
import userService from '../services/userService.js';
import { AppError, asyncHandler } from '../middleware/index.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value: string | undefined): boolean => {
  if (!value) {
    return false;
  }

  return uuidPattern.test(value);
};

export class UserController {
  getAllUsers = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const users = await userService.getAllUsers();
    
    res.status(200).json(users);
  });

  getUserById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      return next(AppError.badRequest('Invalid user ID'));
    }

    const user = await userService.getUserById(id);
    
    if (!user) {
      return next(AppError.notFound('User not found'));
    }

    res.status(200).json(user);
  });

  createUser = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { username, displayName, email, avatarUrl, profileUrl } = req.body;

    if (!username) {
      return next(AppError.badRequest('Username is required.'));
    }

    const user = await userService.createUser({ username, displayName, email, avatarUrl, profileUrl });
    
    res.status(201).json(user);
  });

  updateUser = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
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

    res.status(200).json(user);
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
}

export default new UserController();
