import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import config from './config.js';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * OAuth-CSRF-Schutz für den Authorization-Code-Flow.
 *
 * Pattern: Backend erzeugt einen unvorhersagbaren `state`, legt ihn als
 * HttpOnly-Cookie ab und gibt ihn dem SPA zur Weitergabe an den OAuth-
 * Provider. Beim Callback (`POST /oauth`) muss der zurückkommende `state`
 * byte-gleich zum Cookie sein. Damit kann ein Angreifer einen Login-CSRF
 * nicht in einen anderen Account einschleusen — er kennt den Cookie nicht.
 *
 * Hinweis: Das Setzen des Cookies (`res.cookie(...)`) lassen wir bewusst
 * in den Routes inline mit literalen Optionen — sonst kann CodeQL
 * (js/client-exposed-cookie, js/clear-text-cookie) die `httpOnly`/`secure`-
 * Flags durch die Indirektion nicht erkennen. Geteilt wird nur die
 * Verifikations-Logik (siehe unten), wo die Duplikation am größten war.
 */

/**
 * Räumt das State-Cookie immer ab (auch bei Mismatch) und vergleicht
 * timing-safe gegen den vom Client mitgelieferten Body-State. Liefert
 * `true` nur bei vorhandenem, gleichlangem, bytegleichem Wert.
 */
export function verifyAndClearOAuthStateCookie(
  req: Request,
  res: Response,
  cookieName: string,
  bodyState: unknown,
): boolean {
  const cookieState = req.cookies?.[cookieName];

  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    domain: config.cookieDomain,
    path: config.prefix,
  });

  if (typeof bodyState !== 'string' || typeof cookieState !== 'string') {
    return false;
  }
  const bodyBuf = Buffer.from(bodyState);
  const cookieBuf = Buffer.from(cookieState);
  if (bodyBuf.length !== cookieBuf.length) return false;
  return crypto.timingSafeEqual(bodyBuf, cookieBuf);
}

export default {
  verifyAndClearOAuthStateCookie,
  OAUTH_STATE_TTL_MS,
};
