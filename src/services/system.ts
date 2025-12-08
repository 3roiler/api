import { Request, Response, NextFunction, type RequestHandler } from 'express';
import AppError from './error.js';
import persistence from './persistence.js';
import config from './config.js';
import auth from './auth.js';
import { user } from './index.js';
import { JWTExpired, JWTInvalid } from 'jose/errors';

declare global {
  namespace Express {
    interface Request {
      userId?: string | null;
    }
  }
}

async function verifyToken(token: string) {
  try {
    const accessToken = await auth.verifyToken(token, config.jwtSecret);

    if (!accessToken) {
      throw AppError.unauthorized('Invalid token');
    }

    if (!accessToken.payload?.sub) {
      throw AppError.unauthorized('Invalid token payload');
    }

    const exp = accessToken.payload.exp;
    if (exp && Date.now() >= exp * 1000) {
      throw AppError.unauthorized('Token expired');
    }

    if (accessToken.payload.iss !== config.url) {
      throw AppError.unauthorized('Invalid token issuer');
    }

    const nbf = accessToken.payload.nbf;
    if (nbf && Date.now() < nbf * 1000) {
      throw AppError.unauthorized('Token not yet valid');
    }

    const jti = accessToken.payload.jti;
    if (jti) {
      const isRevoked = await persistence.cache.get(`revoked_token:${jti}`);

      if (isRevoked) {
        throw AppError.unauthorized('Token has been revoked');
      }
    }

    return accessToken;
  } catch (error) {
    if (error instanceof JWTExpired) {
      throw AppError.unauthorized('Token expired');
    }

    if (error instanceof JWTInvalid) {
      throw AppError.unauthorized('Invalid token');
    }

    console.error('Token verification error:', error);
    throw AppError.unauthorized('Token verification failed');
  }
}


const authHandler = async (req: Request, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  let type;
  let token;
  if (authHeader) {
    type = authHeader?.split(' ')[0];
    token = authHeader?.split(' ')[1];
  } else {
    type = 'Bearer';
    token = req.cookies['access_token']
  }

  if (type == 'Bearer' && token) {
    const accessToken = await verifyToken(token);
    req.userId = accessToken.payload.sub;
    return next();
  }
  
  return next(AppError.unauthorized('Authorization header missing or malformed'));
};

const registerHandler = async (req: Request, res: Response, next: NextFunction) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return next(AppError.badRequest('Name, email, and password are required'));
  }

  if (await user.userExists(email)) {
    return next(AppError.conflict('User with this email already exists'));
  }

  const newUser = await user.createUser({ name, email });
  await user.createLogin(newUser.id, email, password);

  return res.status(201).json({
    id: newUser.id,
    name: newUser.name,
    email: newUser.email,
    createdAt: newUser.createdAt
  });
}

const loginHandler = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];

  if (authHeader) {
    const type = authHeader.split(' ')[0];
    const payload = authHeader.split(' ')[1];

    if (type === 'Basic' && payload) {
      const decoded = Buffer.from(payload, 'base64').toString('utf-8');
      const [username, password] = decoded.split(':');

      if (username && password) {
        const result = await user.authenticate(username, password);

        if (result) {
          req.userId = result?.id;
          const token = await auth.generateToken({
            sub: result.id,
            name: result.name
          }, config.jwtSecret);
          const u = await user.getUserById(result.id);

          return res.cookie('access_token', token, {
            httpOnly: true,
            secure: config.isProduction,
            sameSite: 'strict',
            domain: config.url.replace(/^https?:\/\//, '').split(':')[0],
            maxAge: config.jwtExpire,
            path: config.prefix
          }).status(200).json(u);
        } else {
          return next(AppError.unauthorized('Invalid username or password'));
        }
      }
    }
  }
};

const logoutHandler: RequestHandler = async (_, res) => {
  return res.status(200).clearCookie('access_token', {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    domain: config.url.replace(/^https?:\/\//, '').split(':')[0],
    path: config.prefix
  }).send();
}

const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) => {

  if (err instanceof AppError.AppError) {
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
  errorHandler,
  authHandler,
  registerHandler,
  loginHandler,
  logoutHandler,
  getHealthState
};