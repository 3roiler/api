import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import config from './config.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * OAuth-CSRF-Schutz für den Authorization-Code-Flow.
 *
 * Pattern: Backend erzeugt einen unvorhersagbaren `state`, legt ihn als
 * HttpOnly-Cookie ab und gibt ihn dem SPA zur Weitergabe an den OAuth-
 * Provider. Beim Callback (`POST /oauth`) muss der zurückkommende `state`
 * byte-gleich zum Cookie sein. Damit kann ein Angreifer einen Login-CSRF
 * nicht in einen anderen Account einschleusen — er kennt den Cookie nicht.
 *
 * Die Cookie-Optionen werden im Handler INLINE LITERAL gesetzt, damit
 * Static-Analyzer wie CodeQL (js/client-exposed-cookie, js/clear-text-cookie)
 * die `httpOnly`/`secure`-Flags direkt am `res.cookie()`-Aufruf erkennen.
 */

/**
 * Baut einen Express-RequestHandler für `GET /oauth-state`.
 *
 * Wir gehen über eine Factory (statt eines Funktions-Calls in der Route),
 * weil das den OAuth-State-Boilerplate-Code aus den zwei Provider-Routes
 * (`twitch.ts`, `github.ts`) eliminiert — sonst läuft SonarCloud's
 * Code-Duplication-Detection (Quality Gate) auf den symmetrischen Block.
 *
 * Liefert JSON `{ state }`, damit das SPA den Wert in die OAuth-Login-URL
 * einbauen kann. Cookie ist 10 min gültig, dann beim Callback verbraucht.
 */
export function oauthStateHandler(cookieName: string): RequestHandler {
  return (_req, res) => {
    const state = crypto.randomBytes(32).toString('base64url');
    return res.cookie(cookieName, state, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      domain: config.cookieDomain,
      maxAge: OAUTH_STATE_TTL_MS,
      path: config.prefix,
    }).status(200).json({ state });
  };
}

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
  oauthStateHandler,
  verifyAndClearOAuthStateCookie,
};
