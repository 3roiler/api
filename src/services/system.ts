import { Request, Response, NextFunction, type RequestHandler } from 'express';
import { AppError } from './error.js';
import persistence from './persistence.js';
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
        await persistence.database.query('SELECT 1');
        return true;
    } catch (error) {
        console.error('Database health check failed:', error);
        return false;
    }
}

async function checkCache(): Promise<boolean> {
    try {
        await persistence.cache.ping();
        return true;
    } catch (error) {
        console.error('Cache health check failed:', error);
        return false;
    }
}

async function getHealthState() {
    const dbHealthy = await checkDatabase();
    const cacheHealthy = await checkCache();

    return {
        ready: dbHealthy && cacheHealthy,
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