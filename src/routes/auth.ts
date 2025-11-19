import { Router } from 'express';
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import config from '../config/index.js';
import authController from '../controllers/authController.js';

const router = Router();

const isGithubConfigured = (): boolean => Boolean(config.oauth.github.clientId && config.oauth.github.clientSecret);

const handleGithubCallback: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (!isGithubConfigured()) {
        res.status(503).json({ message: 'GitHub OAuth is not configured on the API.' });
        return;
    }

    passport.authenticate('github', {
        failureRedirect: config.oauth.github.failureRedirect || undefined,
        session: false,
    })(req, res, next);
};


const startGithubAuthentication: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (!isGithubConfigured()) {
    res.status(503).json({ message: 'GitHub OAuth is not configured on the API.' });
    return;
  }

  const redirect = typeof req.query.redirect === 'string' && /^\/[a-zA-Z0-9/_\-?&=.%]*$/.test(req.query.redirect) ? req.query.redirect : undefined;

  const state = redirect
    ? Buffer.from(JSON.stringify({ r: redirect })).toString('base64url')
    : undefined;

  passport.authenticate('github', {
    scope: config.oauth.github.scope,
    session: false,
    state
  })(req, res, next);
};

router.get('/github', startGithubAuthentication);
router.get('/github/failure', authController.githubFailure);
router.get('/github/callback', handleGithubCallback, authController.githubCallback);
router.post('/logout', authController.logout);

export default router;
