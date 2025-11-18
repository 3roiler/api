import type { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Secret } from 'jsonwebtoken';
import config from '../config/index.js';

export interface AuthenticateOptions {
  publicPaths?: string[];
}

const normalizePath = (value: string): string => {
  if (value.endsWith('/') && value.length > 1) {
    return value.slice(0, -1);
  }

  return value;
};

const matchesPublicPath = (pathname: string, publicPaths: string[]): boolean => {
  const normalPath = normalizePath(pathname);

  return publicPaths.some((publicPath) => {
    const normalizedPublic = normalizePath(publicPath);

    return normalPath === normalizedPublic || normalPath.startsWith(`${normalizedPublic}/`);
  });
};

const extractBearerToken = (req: Request): string | null => {
  const authHeader = req.get('Authorization');

  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring('Bearer '.length).trim();
  }

  if (config.jwt.cookieName && req.cookies) {
    const cookieToken = req.cookies[config.jwt.cookieName];
    if (typeof cookieToken === 'string' && cookieToken.length > 0) {
      return cookieToken;
    }
  }

  return null;
};

export const allowAnonymous: RequestHandler = (req, _res, next) => {
  req.allowAnonymous = true;
  next();
};

export const authenticate = (options: AuthenticateOptions = {}): RequestHandler => {
  const publicPaths = options.publicPaths ?? [];

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') {
      return next();
    }

    if (req.allowAnonymous) {
      req.allowAnonymous = false;
      return next();
    }

    if (matchesPublicPath(req.path, publicPaths)) {
      return next();
    }

    const token = extractBearerToken(req);

    if (!token) {
      return res.status(401).json({
        identifier: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication token is required to access this resource.'
      });
    }

    try {
      if (!config.jwt.secret) {
        console.error('Authentication attempted but JWT secret is not configured.');
        return res.status(500).json({
          identifier: 'AUTH_CONFIGURATION_ERROR',
          message: 'Authentication is not available. Please contact support.'
        });
      }

      const secret = config.jwt.secret as Secret;
      const decoded = jwt.verify(token, secret);

      if (typeof decoded === 'string') {
        req.auth = {
          token,
          payload: { raw: decoded }
        };
      } else {
        req.auth = {
          token,
          payload: decoded
        };
      }

      return next();
    } catch (error) {
      console.warn('JWT verification failed:', error);
      return res.status(401).json({
        identifier: 'INVALID_TOKEN',
        message: 'The provided authentication token is invalid or expired.',
      });
    }
  };
};
