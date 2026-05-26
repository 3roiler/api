import { Request, Response, NextFunction, type RequestHandler } from 'express';
import * as Sentry from '@sentry/node';
import jose from 'jose';
import AppError from './error.js';
import persistence from './persistence.js';
import config from './config.js';
import auth from './auth.js';
import { user } from './index.js';
import { JWTExpired, JWTInvalid } from 'jose/errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express uses module augmentation via namespace; no ESM alternative exists.
  namespace Express {
    interface Request {
      userId?: string | null;
      // `'bearer'` wenn das JWT aus dem Authorization-Header kam,
      // `'cookie'` wenn aus `cookies.access_token`. Wird vom CSRF-Guard
      // ausgewertet, damit Bearer-Auth nicht stillschweigend am
      // Double-Submit-Cookie vorbeiläuft.
      authSource?: 'bearer' | 'cookie';
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


/**
 * Auth-Middleware: prüft Cookie/Bearer-Token, setzt `req.userId`.
 *
 * Bewusst KEIN DB-Lookup auf `user.deleted_at` pro Request — JWT
 * bleibt stateless. Wenn ein User sich anonymisiert (siehe
 * `userService.anonymizeUser`), wird das Cookie geclearet und die
 * Twitch-OAuth-Token gelöscht; ein bereits ausgestelltes JWT bleibt
 * technisch ~15 min gültig.
 *
 * Akzeptiertes Risiko: ein anonymisierter User könnte ein lokal
 * gespeichertes Cookie wieder in eine Anfrage einsetzen oder gerade
 * laufende Requests könnten noch durchgehen. Blast-Radius = JWT-TTL.
 * Für eine kleine Community-Site ohne Hochsicherheits-Anforderungen
 * ist das tragbar; bei Bedarf wäre ein per-Request-DB-Check oder eine
 * Token-Revocation-Liste (Redis-cached) der nächste Schritt.
 *
 * `getMe` macht für die User-Sicht den DB-Lookup explizit und gibt
 * 401 + Cookie-Clear zurück, sobald deleted_at gesetzt ist — also auf
 * dem ersten Frontend-Roundtrip nach der Anonymisierung ist der
 * User out.
 */
const authHandler = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  let type;
  let token;
  let source: 'bearer' | 'cookie' = 'cookie';
  if (authHeader) {
    type = authHeader?.split(' ')[0];
    token = authHeader?.split(' ')[1];
    source = 'bearer';
  } else {
    type = 'Bearer';
    token = req.cookies['access_token']
  }

  if (type == 'Bearer' && token) {
    const accessToken = await verifyToken(token);
    req.userId = accessToken.payload.sub;
    req.authSource = source;
    return next();
  }

  return next(AppError.unauthorized('Authorization header missing or malformed'));
};

/**
 * Like `authHandler`, but does not reject unauthenticated requests. If a
 * valid Bearer/cookie token is present, `req.userId` is populated; otherwise
 * the request proceeds anonymously. Useful for endpoints that are public but
 * return richer data to signed-in users (e.g. blog list including drafts).
 */
const optionalAuthHandler = async (req: Request, _res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  let type;
  let token;
  let source: 'bearer' | 'cookie' = 'cookie';
  if (authHeader) {
    type = authHeader?.split(' ')[0];
    token = authHeader?.split(' ')[1];
    source = 'bearer';
  } else {
    type = 'Bearer';
    token = req.cookies['access_token'];
  }

  if (type === 'Bearer' && token) {
    try {
      const accessToken = await verifyToken(token);
      req.userId = accessToken.payload.sub;
      req.authSource = source;
    } catch {
      // Bad / expired / revoked token on a public endpoint: treat as anonymous.
    }
  }

  return next();
};

const EMAIL_MAX = 320;
const PASSWORD_MIN = 12;

/**
 * Lightweight email validator without regex backtracking. Mirrors
 * `controllers/admin.ts#isValidEmail` — kept duplicated here to avoid an
 * import from a controller into a service (would invert the layering).
 */
function isValidEmail(value: string): boolean {
  if (value.length === 0 || value.length > EMAIL_MAX) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

const registerHandler = async (req: Request, res: Response, next: NextFunction) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return next(AppError.badRequest('Name, email, and password are required'));
  }

  if (typeof email !== 'string' || !isValidEmail(email)) {
    return next(AppError.badRequest('Bitte eine gültige E-Mail-Adresse angeben.', 'BAD_EMAIL'));
  }

  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return next(AppError.badRequest(
      `Passwort muss mindestens ${PASSWORD_MIN} Zeichen lang sein.`,
      'WEAK_PASSWORD'
    ));
  }

  // Bewusste UX-Entscheidung: 409 bleibt — eine generische Fehlermeldung
  // würde dem User die Diagnose erschweren („warum klappt das nicht?").
  // User-Enumeration wird stattdessen durch den 5/15-min-Limiter auf
  // `/register` (siehe app.ts) unpraktisch.
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

          // `sameSite: 'lax'` (nicht `'strict'`), damit das Cookie auch nach
          // einem externen Redirect (z.B. OAuth-Callback von Twitch/GitHub
          // zurück auf broiler.dev) mitgeschickt wird. `strict` würde die
          // Session in genau diesen Fluss-Übergängen tot machen. Konsistent
          // mit `logoutHandler` und den OAuth-Handlern.
          return res.cookie('access_token', token, {
            httpOnly: true,
            secure: config.isProduction,
            sameSite: 'lax',
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

/**
 * JWT aus Cookie ODER Bearer-Header lesen und den `jti` in den
 * Revocation-Cache schreiben (TTL = Token-Restlaufzeit). Bewusst KEINE
 * Verifikation — ein abgelaufenes oder gestohlenes Token soll trotzdem
 * revoked werden können. Best-effort: Defekte Tokens werden geloggt, nicht
 * geworfen, damit Logout/Nuke nicht an einem kaputten Cookie scheitern.
 *
 * Genutzt von `logoutHandler` (Standard-Logout) und `userController.nukeMePlease`
 * (Self-Anonymize via DSGVO).
 */
async function revokeCurrentToken(req: Request, contextLabel: string): Promise<void> {
  const authHeader = req.headers['authorization'];
  let token: string | undefined;
  if (authHeader) {
    const [type, value] = authHeader.split(' ');
    if (type === 'Bearer' && value) token = value;
  } else {
    token = req.cookies?.['access_token'];
  }

  if (!token) return;

  try {
    const payload = jose.decodeJwt(token);
    const jti = payload.jti;
    const exp = payload.exp; // Sekunden seit Epoch
    if (typeof jti === 'string' && typeof exp === 'number') {
      const nowSec = Math.floor(Date.now() / 1000);
      const ttlSec = exp - nowSec;
      if (ttlSec > 0) {
        // Revocation-Eintrag lebt nur so lange wie das Token selbst —
        // danach würde es ohnehin in `verifyToken` als expired abgewiesen.
        await persistence.cache.set(`revoked_token:${jti}`, '1', { EX: ttlSec });
      }
    }
  } catch (err) {
    console.warn(`[${contextLabel}] could not decode token for revocation:`, err);
  }
}

const logoutHandler: RequestHandler = async (req, res) => {
  await revokeCurrentToken(req, 'logout');

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

  // Non-AppError = unerwarteter 500er. An Sentry melden, sofern
  // SENTRY_DSN gesetzt ist; ohne DSN ist `captureException` ein
  // No-Op (siehe services/sentry.ts). Wir attachen den Request-
  // Path als Tag, damit Aggregation in der Sentry-UI brauchbar wird.
  Sentry.captureException(err, {
    tags: {
      // `req.path` enthält noch keine Query — gut für Aggregation.
      path: req.path,
      method: req.method
    }
  });
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
  optionalAuthHandler,
  registerHandler,
  loginHandler,
  logoutHandler,
  revokeCurrentToken,
  getHealthState
};