import { Request, Response, NextFunction } from 'express';
import { user, error } from '../services';

const getAllUsers = async (req: Request, res: Response, next: NextFunction) => {
  const users = await user.getAllUsers();
  return res.status(200).json(users);
};

const getUserById = async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;

  const data = await user.getUserById(id);

  if (!data) {
    return next(error.notFound('User not found'));
  }

  return res.status(200).json(data);
};

const createUser = async (req: Request, res: Response, next: NextFunction) => {
  const options = req.body;

  if (!options.name) {
    return next(error.badRequest('Name is required'));
  }

  const data = await user.createUser(options);
  return res.status(201).json(data);
};

const updateUser = async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const options = req.body;

  if (!options.name && options.displayName === undefined && options.email === undefined) {
    return next(error.badRequest('At least one field (name, displayName, email) must be provided'));
  }

  const data = await user.updateUser(id, options);

  if (!data) {
    return next(error.notFound('User not found'));
  }

  return res.status(200).json(data);
};

const deleteUser = async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const deleted = await user.deleteUser(id);

  if (!deleted) {
    return next(error.notFound('User not found'));
  }

  return res.status(204);
};

const nukeMePlease = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.userId) {
    return next(error.unauthorized('No authenticated user.'));
  }

  console.info(`User ${req.userId} requested nukeMePlease lol`);
  await user.deleteUser(req.userId);
  return res.status(204).send();
};

const getMe = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.userId) {
    return next(error.unauthorized('No authenticated user.'));
  }

  const data = await user.getUserById(req.userId);

  if (!data) {
    return next(error.notFound('Authenticated user not found.'));
  }

  return res.status(200).json(data);
};

export default {
  getAllUsers,
  getUserById,
  nukeMePlease,
  createUser,
  updateUser,
  deleteUser,
  getMe
};