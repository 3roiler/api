import { Request, Response, NextFunction } from 'express';
import userService from '../services/userService';
import { AppError, asyncHandler } from '../middleware/errorHandler';

export class UserController {
  getAllUsers = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const users = await userService.getAllUsers();
    
    res.status(200).json(users);
  });

  getUserById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const id = Number.parseInt(req.params.id);
    
    if (Number.isNaN(id)) {
      return next(AppError.badRequest('Invalid user ID'));
    }

    const user = await userService.getUserById(id);
    
    if (!user) {
      return next(AppError.notFound('User not found'));
    }

    res.status(200).json(user);
  });

  createUser = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { username } = req.body;

    if (!username) {
      return next(AppError.badRequest('Username is required.'));
    }

    const user = await userService.createUser(username);
    
    res.status(201).json(user);
  });

  updateUser = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const id = Number.parseInt(req.params.id);
    const { username } = req.body;

    if (Number.isNaN(id)) {
      return next(AppError.badRequest('Invalid user ID'));
    }

    if (!username) {
      return next(AppError.badRequest('Username is required.'));
    }

    const user = await userService.updateUser(id, username);
    
    if (!user) {
      return next(AppError.notFound('User not found'));
    }

    res.status(200).json(user);
  });

  deleteUser = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const id = Number.parseInt(req.params.id);

    if (Number.isNaN(id)) {
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
