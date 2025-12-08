import { Request, Response, NextFunction, type RequestHandler, response } from 'express';
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

const authHandler = async (req: Request, res: Response, next: NextFunction) => {
  var authHeader = req.headers['authorization'];
  var type;
  var token;
  if(authHeader) {
    type = authHeader && authHeader.split(' ')[0];
    token = authHeader && authHeader.split(' ')[1];
  } else {
    type = 'Bearer';
    token = req.cookies['access_token']
  }

  if (type == 'Bearer' && token) {

    var accessToken;
    try {
      accessToken = await auth.verifyToken(token, config.jwtSecret);
    } catch (error) {

      if(error instanceof JWTExpired){
        return next(AppError.unauthorized('Token expired'));
      }

      if(error instanceof JWTInvalid){
        return next(AppError.unauthorized('Invalid token'));
      }

      console.error('Token verification error:', error);
      return next(AppError.unauthorized('Token verification failed'));
    }
    
    if(!accessToken){
      return next(AppError.unauthorized('Invalid token'));
    }

    if(!accessToken.payload || !accessToken.payload.sub){
      return next(AppError.unauthorized('Invalid token payload'));
    }

    var exp = accessToken.payload.exp;
    if(exp && Date.now() >= exp * 1000){
      return next(AppError.unauthorized('Token expired'));
    }

    if(accessToken.payload.iss !== config.url){
      return next(AppError.unauthorized('Invalid token issuer'));
    }

    var nbf = accessToken.payload.nbf;
    if(nbf && Date.now() < nbf * 1000){
      return next(AppError.unauthorized('Token not yet valid'));
    }

    var jti = accessToken.payload.jti;
    if(jti){
      var isRevoked = await persistence.cache.get(`revoked_token:${jti}`);

      if(isRevoked){
        return next(AppError.unauthorized('Token has been revoked'));
      }
    }

    req.userId = accessToken.payload.sub as string;
    return next();
  }
  return next(AppError.unauthorized('Authorization header missing or malformed'));
};

const registerHandler = async (req: Request, res: Response, next: NextFunction) => {
  var { name, email, password } = req.body;
  if (!name || !email || !password) {
    return next(AppError.badRequest('Name, email, and password are required'));
  }

  if (await user.userExists(email)) {
      return next(AppError.conflict('User with this email already exists'));
    }
    
    var newUser = await user.createUser({ name, email });
    await user.createLogin(newUser.id, email, password);

    return res.status(201).json({
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      createdAt: newUser.createdAt
    });
}

const loginHandler = async (req: Request, res: Response, next: NextFunction) => {
  var authHeader = req.headers['authorization'];
  
  if (authHeader) {
    var type = authHeader.split(' ')[0];
    var payload = authHeader.split(' ')[1];

    if (type === 'Basic' && payload) {
      var decoded = Buffer.from(payload, 'base64').toString('utf-8');
      var [username, password] = decoded.split(':');

      if (username && password) {
        var result = await user.authenticate(username, password);

        if (result) {
          req.userId = result?.id;
          var token = await auth.generateToken( {
            sub: result.id, 
            name: result.name
          }, config.jwtSecret);
          var u = await user.getUserById(result.id);

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
  getHealthState
};