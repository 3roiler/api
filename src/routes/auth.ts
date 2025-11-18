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

  passport.authenticate('github', {
    scope: config.oauth.github.scope,
    session: false
  })(req, res, next);
};

router.get('/github', startGithubAuthentication);
router.get('/github/failure', authController.githubFailure);
router.get('/github/callback', handleGithubCallback, authController.githubCallback);
router.post('/logout', authController.logout);

export default router;
