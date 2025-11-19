import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { OAuthSessionStore } from '../../types/auth.js';
import { AppError } from '../../middleware/index.js';

const ensureSession = (req: Request): OAuthSessionStore => {
  const session = req.session;

  if (!session) {
    throw AppError.internal('Session support is required for OAuth flows.');
  }

  if (!session.oauth) {
    session.oauth = {};
  }

  return session.oauth;
};

export const initializeOAuthSession = (req: Request, provider: string, redirect: string | null): string => {
  const store = ensureSession(req);
  const state = randomBytes(24).toString('hex');

  store[provider] = {
    provider,
    state,
    redirect,
    createdAt: Date.now(),
  };

  return state;
};

export const consumeOAuthSession = (req: Request, provider: string, stateParam: string, stateMaxAgeMs: number): string | null => {
  const session = ensureSession(req);
  const entry = session[provider];
  session[provider] = undefined;

  if (!entry) {
    throw AppError.badRequest('OAuth session is no longer available. Please restart the login.');
  }

  if (entry.state !== stateParam) {
    throw AppError.badRequest('OAuth state verification failed.');
  }

  if (Date.now() - entry.createdAt > stateMaxAgeMs) {
    throw AppError.badRequest('OAuth state has expired. Please initiate the login flow again.');
  }

  return entry.redirect;
};

export const clearOAuthSession = (req: Request, provider: string): void => {
  const session = req.session;

  if (!session || !session.oauth) {
    return;
  }

  session.oauth[provider] = undefined;
};
