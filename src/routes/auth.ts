import { Router } from 'express';
import type { RequestHandler } from 'express';
import passport from 'passport';
import authController from '../controllers/authController.js';
import { getOAuthProvider, ensureProviderEnabled } from '../services/oauth/providerService.js';
import { resolveRedirectTarget } from '../services/oauth/redirectService.js';
import { initializeOAuthSession } from '../services/oauth/stateService.js';

const router = Router();

const createStartHandler = (providerKey: string): RequestHandler => {
  return (req, res, next) => {
    try {
      const provider = getOAuthProvider(providerKey);
      ensureProviderEnabled(provider);

      const redirectTarget = resolveRedirectTarget(req, provider);
      const state = initializeOAuthSession(req, provider.key, redirectTarget);

      const authenticator = passport.authenticate(provider.strategyName, {
        scope: provider.scope,
        session: false,
        state,
      }) as RequestHandler;

      authenticator(req, res, next);
    } catch (error) {
      next(error);
    }
  };
};

const createCallbackHandler = (providerKey: string): RequestHandler => {
  return (req, res, next) => {
    try {
      const provider = getOAuthProvider(providerKey);
      ensureProviderEnabled(provider);

      const authenticator = passport.authenticate(provider.strategyName, {
        failureRedirect: provider.failureRedirect || undefined,
        session: false,
      }) as RequestHandler;

      authenticator(req, res, next);
    } catch (error) {
      next(error);
    }
  };
};

const registerProviderRoutes = (providerKey: string) => {
  router.get(`/${providerKey}`, createStartHandler(providerKey));
  router.get(`/${providerKey}/failure`, authController.getOAuthFailureHandler(providerKey));
  router.get(`/${providerKey}/callback`, createCallbackHandler(providerKey), authController.getOAuthCallbackHandler(providerKey));
};

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Invalidate the current session tokens
 *     tags:
 *       - Authentication
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     responses:
 *       '204':
 *         description: Session terminated.
 */
router.post('/logout', authController.logout);

registerProviderRoutes('github');

export default router;
