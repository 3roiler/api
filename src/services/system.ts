import { Request, Response, NextFunction, type RequestHandler } from 'express';
import { AppError } from './error.js';
import { pool } from './persistence.js';
import config from './config.js';

const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      identifier: err.identifier,
      message: err.message
    });
  }

  console.error('ERROR 💥:', err);

  return res.status(500).json({
    identifier: 'API_ERROR',
    message: 'An internal server error occurred.'
  });
};

async function checkDatabase(): Promise<boolean> {
    try {
        await pool.query('SELECT 1');
        return true;
    } catch (error) {
        console.error('Database health check failed:', error);
        return false;
    }
}

async function getHealthState() {
    const dbHealthy = await checkDatabase();

    return {
        ready: dbHealthy,
        timestamp: new Date().toISOString(),
        service: config.url + config.prefix,
        uptime: process.uptime(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        contact: config.contact
    };
}

export default {
  asyncHandler,
  errorHandler,
  getHealthState
};