import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

export const notFound = (req: Request, res: Response, next: NextFunction) => {
  next(AppError.notFound(`Route ${req.originalUrl} not found`));
};
