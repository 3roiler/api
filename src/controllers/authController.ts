import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { SignOptions, Secret } from 'jsonwebtoken';
import config from '../config/index.js';
import { AppError, asyncHandler } from '../middleware/index.js';
import userService from '../services/userService.js';
import type { GitHubAuthUser } from '../types/auth.js';

const buildRedirectUrl = (target: string, token: string): string => {
  const isAbsolute = /^https?:\/\//i.test(target);
  const url = isAbsolute ? new URL(target) : new URL(target, config.apiBaseUrl);
  url.searchParams.set('token', token);
  return url.toString();
};

class AuthController {
    
  githubCallback = asyncHandler(async (req: Request, res: Response) => {
    const authenticatedUser = req.user as GitHubAuthUser | undefined;

    if (!authenticatedUser) {
      throw AppError.badRequest('GitHub authentication failed.');
    }

    if (!config.jwt.secret) {
      throw AppError.internal('JWT secret is not configured.');
    }

    const persistedUser = await userService.upsertGitHubUser(authenticatedUser);
    const { user, groups, scopes } = await userService.getUserAuthorization(persistedUser.id);

    const groupSlugs = groups.map((group) => group.slug);
    const scopeKeys = scopes.map((scope) => scope.key);

    const payload = {
      sub: user.id,
      provider: authenticatedUser.provider,
      username: user.username,
      displayName: user.displayName ?? user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      profileUrl: user.profileUrl,
      groups: groupSlugs,
      scopes: scopeKeys,
    };

    const signOptions: SignOptions = {
      expiresIn: config.jwt.expiresIn as SignOptions['expiresIn'],
    };

    const token = jwt.sign(payload, config.jwt.secret as Secret, signOptions);

    if (config.jwt.cookieName) {
      const secureCookie = config.jwt.secureCookie ?? config.isProduction;

      res.cookie(config.jwt.cookieName, token, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'lax',
        domain: config.jwt.cookieDomain,
        maxAge: config.jwt.cookieMaxAgeMs,
      });
    }

    if (config.oauth.github.successRedirect) {
      try {
        const redirectUrl = buildRedirectUrl(config.oauth.github.successRedirect, token);
        res.redirect(redirectUrl);
        return;
      } catch (error) {
        console.error('Failed to assemble success redirect URL. Responding with JSON instead.', error);
      }
    }

    res.status(200).json({
      token,
      user,
      groups,
      scopes,
    });
  });

  githubFailure = (req: Request, res: Response) => {
    if (config.oauth.github.failureRedirect) {
      res.redirect(config.oauth.github.failureRedirect);
      return;
    }

    res.status(401).json({ message: 'GitHub authentication was cancelled or failed.' });
  };

  logout = (req: Request, res: Response, next: NextFunction) => {
    if (config.jwt.cookieName) {
      const secureCookie = config.jwt.secureCookie ?? config.isProduction;

      res.clearCookie(config.jwt.cookieName, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'lax',
        domain: config.jwt.cookieDomain,
      });
    }

    const handleLogoutCompletion = (error?: Error | null) => {
      if (error) {
        next(error);
        return;
      }

      const session = req.session;

      if (session) {
        session.destroy(() => undefined);
      }

      res.status(204).send();
    };

    if (typeof req.logout === 'function') {
      req.logout(handleLogoutCompletion);
      return;
    }

    handleLogoutCompletion();
  };
}

export default new AuthController();
