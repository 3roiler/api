import { Request, Response, NextFunction } from 'express';
import config from '../services/config.js';
import AppError from '../services/error.js';

/**
 * CSRF-Schutz per Origin-Validierung (OWASP "Verifying Origin With
 * Standard Headers"). Ergänzt den SameSite-Cookie um eine zweite Schicht.
 *
 * Greift nur, wenn ALLE drei Bedingungen zutreffen:
 *   1. mutierende Methode (nicht GET/HEAD/OPTIONS),
 *   2. der Request trägt das Cookie-basierte Auth-Token — Token-Clients
 *      (z. B. der Drucker-Agent via X-Agent-Token) und anonyme Requests
 *      sind nicht CSRF-gefährdet und passieren ungeprüft,
 *   3. eine Origin-Whitelist ist konfiguriert (Prod via CORS_ORIGIN).
 *
 * Im Dev ohne CORS_ORIGIN wird NICHT erzwungen (lokales Arbeiten).
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const AUTH_COOKIE = 'access_token';

/** Erlaubte Origins für mutierende Requests. null = nicht erzwingen (Dev). */
function allowedOrigins(): string[] | null {
  if (config.corsOrigin && config.corsOrigin !== '*') {
    return config.corsOrigin.split(',').map((o) => o.trim());
  }
  // In Prod ohne explizite Whitelist: kein Cross-Origin erlauben.
  return config.isProduction ? [] : null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Normalisiert Origin- oder Referer-Header auf eine reine Origin. */
function toOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.cookies?.[AUTH_COOKIE]) return next();

  const allowed = allowedOrigins();
  if (allowed === null) return next();

  const origin =
    toOrigin(firstHeader(req.headers.origin)) ?? toOrigin(firstHeader(req.headers.referer));

  if (!origin || !allowed.includes(origin)) {
    return next(AppError.forbidden('CSRF-Schutz: ungültige oder fehlende Origin.', 'CSRF_ORIGIN'));
  }
  return next();
}

export default csrfGuard;
