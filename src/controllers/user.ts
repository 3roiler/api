import { Request, Response, NextFunction } from 'express';
import { system, user, error } from '../services';

   const getAllUsers = system.asyncHandler(async (req: Request, res: Response) => {
    const users = await user.getAllUsers();
    res.status(200).json(users);
  });

  const getUserById = system.asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;

    const data = await user.getUserById(id);

    if (!data) {
      return next(error.notFound('User not found'));
    }

    res.status(200).json(data);
  });

  const createUser = system.asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const options = req.body;

    if (!options.name) {
      return next(error.badRequest('Name is required.'));
    }

    const data = await user.createUser(options);
    res.status(201).json(data);
  });

  const updateUser = system.asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const options = req.body;

    if (!options.name && options.displayName === undefined && options.email === undefined) {
      return next(error.badRequest('At least one field (name, displayName, email) must be provided.'));
    }

    const data = await user.updateUser(id, options);

    if (!data) {
      return next(error.notFound('User not found'));
    }

    res.status(200).json(data);
  });

  const deleteUser = system.asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const deleted = await user.deleteUser(id);
    
    if (!deleted) {
      return next(error.notFound('User not found'));
    }

    return res.status(204);
  });

  const nukeMePlease = system.asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if(!req.userId){
      return next(error.unauthorized('No authenticated user.'));
    }

    console.info(`User ${req.userId} requested nukeMePlease lol`);
    await user.deleteUser(req.userId);
    return res.status(204);
  });

  const getMe = system.asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if(!req.userId){
      return next(error.unauthorized('No authenticated user.'));
    }

    const data = await user.getUserById(req.userId);

    if (!data) {
      return next(error.notFound('Authenticated user not found.'));
    }

    return res.status(200).json(data);
  });

export default {
  getAllUsers,
  getUserById,
  nukeMePlease,
  createUser,
  updateUser,
  deleteUser,
  getMe
};