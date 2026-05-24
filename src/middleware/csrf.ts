import { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'node:crypto';
import config from '../services/config.js';
import AppError from '../services/error.js';

/**
 * CSRF-Schutz nach dem Double-Submit-Cookie-Muster (OWASP).
 *
 * Ablauf:
 *   1. Jede Antwort stellt ein lesbares `XSRF-TOKEN`-Cookie bereit (falls noch
 *      keins existiert). Das SPA liest den Wert über `GET /api/csrf` (Body)
 *      und schickt ihn bei mutierenden Requests im Header `X-CSRF-Token`.
 *   2. Bei mutierenden, Cookie-authentifizierten Requests muss der Header mit
 *      dem Cookie übereinstimmen — ein Angreifer auf einer Fremdseite kann das
 *      `XSRF-TOKEN`-Cookie weder lesen noch den Header setzen.
 *
 * Greift, wenn der Request mutiert (nicht GET/HEAD/OPTIONS) UND entweder
 *   - per Cookie authentifiziert ist (`access_token`-Cookie), ODER
 *   - per `Authorization: Bearer …`-Header. Bearer hebelt den
 *     SameSite-Schutz nicht aus, aber XHR aus einem fremden Tab könnte
 *     mit gestohlenem Token Mutationen auslösen — daher zusätzlich Header
 *     verlangen. Service-Tokens des Druckers laufen über
 *     `X-Agent-Token`, nicht über `Authorization`, und sind unbetroffen.
 *
 * Hinweis: Die String-Literale `'XSRF-TOKEN'` (Cookie setzen) und der
 * `req.cookies['XSRF-TOKEN']`-Vergleich sind bewusst inline gehalten — die
 * statische CSRF-Erkennung (CodeQL `js/missing-token-validation`) erkennt den
 * Schutz genau an diesem Cookie-Namen + Vergleich.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const AUTH_COOKIE = 'access_token';
const CSRF_HEADER = 'x-csrf-token';

function hasBearerAuth(req: Request): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const [type, value] = header.split(' ');
  return type === 'Bearer' && !!value;
}

/** Cookie-Optionen für das (lesbare) CSRF-Token. */
function csrfCookieOptions() {
  return {
    httpOnly: false, // muss für das SPA lesbar bleiben (Double-Submit)
    secure: config.isProduction,
    sameSite: 'lax' as const,
    domain: config.cookieDomain,
    path: config.prefix
  };
}

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export const csrfGuard: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  // Token-Cookie sicherstellen, damit das SPA es per GET /csrf abholen kann.
  let token = req.cookies?.['XSRF-TOKEN'];
  if (!token) {
    token = newToken();
    res.cookie('XSRF-TOKEN', token, csrfCookieOptions());
  }
  res.locals.csrfToken = token;

  if (SAFE_METHODS.has(req.method)) return next();
  // Weder Cookie-Auth noch Bearer-Auth → kein CSRF-Risiko (anonyme oder
  // Agent-Token-Requests via `X-Agent-Token`). Passieren lassen.
  if (!req.cookies?.[AUTH_COOKIE] && !hasBearerAuth(req)) return next();

  const sent = req.get(CSRF_HEADER);
  if (!sent || sent !== req.cookies['XSRF-TOKEN']) {
    return next(AppError.forbidden('CSRF-Token fehlt oder ungültig.', 'CSRF_TOKEN'));
  }
  return next();
};

/**
 * GET /api/csrf — liefert den aktuellen Token im Body. Das SPA ruft dies beim
 * Start (und nach einem 403) auf und cached den Wert für den Header.
 */
export const csrfTokenHandler: RequestHandler = (_req: Request, res: Response) => {
  return res.status(200).json({ csrfToken: res.locals.csrfToken });
};

export default csrfGuard;
