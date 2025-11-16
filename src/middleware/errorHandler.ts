import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  statusCode: number;
  identifier: string;

  constructor(statusCode: number, identifier: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.identifier = identifier;

    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, identifier: string = 'BAD_REQUEST') {
    return new AppError(400, identifier, message);
  }

  static notFound(message: string, identifier: string = 'NOT_FOUND') {
    return new AppError(404, identifier, message);
  }

  static internal(message: string, identifier: string = 'INTERNAL_SERVER_ERROR') {
    return new AppError(500, identifier, message);
  }
}

export const errorHandler = (err: Error | AppError, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      identifier: err.identifier,
      message: err.message
    });
  }

  console.error('ERROR 💥:', err);

  return res.status(500).json({
    identifier: 'API_ERROR',
    message: 'An internal server error occurred.',
  });
};

export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};