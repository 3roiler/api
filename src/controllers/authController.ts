import { randomBytes, createHash } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler, CookieOptions } from 'express';
import jwt from 'jsonwebtoken';
import type { SignOptions, Secret } from 'jsonwebtoken';
import config from '../config/index.js';
import { AppError, asyncHandler } from '../middleware/index.js';
import userService from '../services/userService.js';
import { consumeOAuthSession, clearOAuthSession } from '../services/oauth/stateService.js';
import { ensureProviderEnabled, getOAuthProvider } from '../services/oauth/providerService.js';
import type { OAuthAuthenticatedUser } from '../types/auth.js';
import type { OAuthProviderConfig } from '../types/oauth.js';
import type { RefreshToken, UserAuthorization } from '../models/index.js';
import { serializeUser } from '../utils/userSerializer.js';

const extractStateParam = (req: Request): string => {
  const rawState = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;

  if (typeof rawState !== 'string' || rawState.length === 0) {
    throw AppError.badRequest('Missing OAuth state returned from the provider.');
  }

  return rawState;
};

const buildRedirectUrl = (provider: OAuthProviderConfig, target: string, token: string): string => {
  const base = provider.baseRedirectUrl || config.apiBaseUrl;
  const url = new URL(target, base);
  url.searchParams.set('token', token);
  return url.toString();
};

const REFRESH_TOKEN_BYTE_LENGTH = 48;

const toUrlSafeBase64 = (buffer: Buffer): string =>
  buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');

const createRefreshTokenValue = (): string => toUrlSafeBase64(randomBytes(REFRESH_TOKEN_BYTE_LENGTH));

const hashRefreshToken = (value: string): string => createHash('sha256').update(value).digest('hex');

const extractTokenClientInfo = (req: Request) => ({
  userAgent: req.get('user-agent') ?? null,
  ipAddress: req.ip ?? null,
});

class AuthController {
  private setJwtCookie(res: Response, token: string): void {
    const cookieName = config.jwt.cookieName;

    if (!cookieName) {
      return;
    }

    const options: CookieOptions = {
      httpOnly: true,
      secure: config.jwt.secureCookie ?? config.isProduction,
      sameSite: 'lax',
      domain: config.jwt.cookieDomain,
      path: '/',
    };

    if (config.jwt.cookieMaxAgeMs) {
      options.maxAge = config.jwt.cookieMaxAgeMs;
    }

    res.cookie(cookieName, token, options);
  }

  private clearJwtCookie(res: Response): void {
    const cookieName = config.jwt.cookieName;

    if (!cookieName) {
      return;
    }

    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: config.jwt.secureCookie ?? config.isProduction,
      sameSite: 'lax',
      domain: config.jwt.cookieDomain,
      path: '/',
    });
  }

  private setRefreshCookie(res: Response, token: string): void {
    const refreshConfig = config.refreshToken;

    if (!refreshConfig?.cookieName) {
      return;
    }

    const options: CookieOptions = {
      httpOnly: true,
      secure: refreshConfig.secureCookie ?? config.isProduction,
      sameSite: 'lax',
      domain: refreshConfig.cookieDomain,
      path: '/',
    };

    if (refreshConfig.cookieMaxAgeMs) {
      options.maxAge = refreshConfig.cookieMaxAgeMs;
    } else if (refreshConfig.tokenTtlMs) {
      options.maxAge = refreshConfig.tokenTtlMs;
    }

    res.cookie(refreshConfig.cookieName, token, options);
  }

  private clearRefreshCookie(res: Response): void {
    const refreshConfig = config.refreshToken;

    if (!refreshConfig?.cookieName) {
      return;
    }

    res.clearCookie(refreshConfig.cookieName, {
      httpOnly: true,
      secure: refreshConfig.secureCookie ?? config.isProduction,
      sameSite: 'lax',
      domain: refreshConfig.cookieDomain,
      path: '/',
    });
  }

  private async manageRefreshToken(
    req: Request,
    res: Response,
    provider: OAuthProviderConfig,
    userId: string,
    rotationSource?: RefreshToken
  ): Promise<void> {
    const refreshConfig = config.refreshToken;

    if (!refreshConfig?.cookieName || !refreshConfig.tokenTtlMs) {
      return;
    }

    const refreshValue = createRefreshTokenValue();
    const refreshHash = hashRefreshToken(refreshValue);
    const expiresAt = new Date(Date.now() + refreshConfig.tokenTtlMs);
    const clientInfo = extractTokenClientInfo(req);

    if (rotationSource) {
      await userService.rotateRefreshToken(rotationSource, {
        tokenHash: refreshHash,
        expiresAt,
        userAgent: clientInfo.userAgent,
        ipAddress: clientInfo.ipAddress,
      });
    } else {
      await userService.createRefreshToken({
        userId,
        provider: provider.key,
        tokenHash: refreshHash,
        expiresAt,
        userAgent: clientInfo.userAgent,
        ipAddress: clientInfo.ipAddress,
      });
    }

    this.setRefreshCookie(res, refreshValue);
  }

  private async issueSessionTokens(
    req: Request,
    res: Response,
    provider: OAuthProviderConfig,
    authorization: UserAuthorization,
    options: { rotationSource?: RefreshToken } = {}
  ): Promise<{ token: string; user: Record<string, unknown>; groups: UserAuthorization['groups']; scopes: UserAuthorization['scopes'] }> {
    if (!config.jwt.secret) {
      throw AppError.internal('JWT secret is not configured.');
    }

    const groupSlugs = authorization.groups.map((group) => group.slug);
    const scopeKeys = authorization.scopes.map((scope) => scope.key);

    const payload = {
      sub: authorization.user.id,
      provider: provider.key,
      username: authorization.user.username,
      displayName: authorization.user.displayName ?? authorization.user.username,
      email: authorization.user.email,
      avatarUrl: authorization.user.avatarUrl,
      profileUrl: authorization.user.profileUrl,
      groups: groupSlugs,
      scopes: scopeKeys,
    };

    const signOptions: SignOptions = {
      expiresIn: config.jwt.expiresIn as SignOptions['expiresIn'],
    };

    const token = jwt.sign(payload, config.jwt.secret as Secret, signOptions);

    this.setJwtCookie(res, token);
    await this.manageRefreshToken(req, res, provider, authorization.user.id, options.rotationSource);

    const userView = serializeUser(authorization.user, { scopes: scopeKeys, isSelf: true });

    return {
      token,
      user: userView,
      groups: authorization.groups,
      scopes: authorization.scopes,
    };
  }

  private createOAuthCallbackHandler(providerKey: string) {
    return asyncHandler(async (req: Request, res: Response) => {
      const provider = getOAuthProvider(providerKey);
      ensureProviderEnabled(provider);

      let stateParam: string;

      try {
        stateParam = extractStateParam(req);
      } catch (error) {
        clearOAuthSession(req, provider.key);
        throw error;
      }

      const redirectTarget = consumeOAuthSession(req, provider.key, stateParam, provider.stateMaxAgeMs);
      const authenticatedUser = req.user as OAuthAuthenticatedUser | undefined;

      if (!authenticatedUser) {
        throw AppError.badRequest(`${provider.displayName} authentication failed.`);
      }

      await this.handleOAuthSuccess(req, res, provider, authenticatedUser, redirectTarget);
    });
  }

  private createOAuthFailureHandler(providerKey: string) {
    return (req: Request, res: Response) => {
      const provider = getOAuthProvider(providerKey);
      clearOAuthSession(req, provider.key);

      if (provider.failureRedirect) {
        res.redirect(provider.failureRedirect);
        return;
      }

      res.status(401).json({ message: `${provider.displayName} authentication was cancelled or failed.` });
    };
  }

  githubCallback = this.createOAuthCallbackHandler('github');

  githubFailure = this.createOAuthFailureHandler('github');

  getOAuthCallbackHandler(providerKey: string): RequestHandler {
    return this.createOAuthCallbackHandler(providerKey);
  }

  getOAuthFailureHandler(providerKey: string): RequestHandler {
    return this.createOAuthFailureHandler(providerKey);
  }

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

    this.clearRefreshCookie(res);

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

  private async handleOAuthSuccess(
    req: Request,
    res: Response,
    provider: OAuthProviderConfig,
    authenticatedUser: OAuthAuthenticatedUser,
    redirectTarget: string | null
  ) {
    const persistedUser = await userService.upsertOAuthUser(authenticatedUser);
    const authorization = await userService.getUserAuthorization(persistedUser.id);
    const { token, user, groups, scopes } = await this.issueSessionTokens(req, res, provider, authorization);

    if (redirectTarget) {
      try {
        const redirectUrl = buildRedirectUrl(provider, redirectTarget, token);
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
      redirect: redirectTarget,
    });
  }
}

export default new AuthController();
