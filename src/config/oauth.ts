import { parseNumber } from '../utils/env.js';
import { parseOriginList, toOriginOrUndefined, toUrlOrNull } from '../utils/url.js';
import type { OAuthConfig, OAuthProviderConfig } from '../types/oauth.js';

const normalizeScope = (scope?: string): string[] => {
  if (!scope) {
    return ['read:user', 'user:email'];
  }

  return scope
    .split(/[ ,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

interface BuildProviderOptions {
  apiBaseUrl: string;
  apiPrefix: string;
}

const buildGithubConfig = ({ apiBaseUrl, apiPrefix }: BuildProviderOptions): OAuthProviderConfig => {
  const clientId = process.env.GITHUB_CLIENT_ID || '';
  const clientSecret = process.env.GITHUB_CLIENT_SECRET || '';
  const callbackUrl = process.env.GITHUB_CALLBACK_URL || '';
  const successRedirect = process.env.GITHUB_SUCCESS_REDIRECT || '';
  const failureRedirect = process.env.GITHUB_FAILURE_REDIRECT || '';
  const defaultRedirect = process.env.GITHUB_DEFAULT_REDIRECT || successRedirect;
  const allowedRedirectOrigins = parseOriginList(process.env.GITHUB_REDIRECT_ALLOW_LIST);
  const stateMaxAgeMs = parseNumber(process.env.GITHUB_STATE_MAX_AGE_MS) ?? 5 * 60 * 1000;
  const callback = callbackUrl || `${apiBaseUrl}${apiPrefix}/auth/github/callback`;
  const apiBaseOrigin = toOriginOrUndefined(apiBaseUrl);
  const successOrigin = toOriginOrUndefined(successRedirect);
  const defaultOrigin = toOriginOrUndefined(defaultRedirect) ?? successOrigin ?? apiBaseOrigin;
  const baseRedirect = toUrlOrNull(defaultRedirect)?.origin
    ?? toUrlOrNull(successRedirect)?.origin
    ?? apiBaseUrl;

  const origins = Array.from(
    new Set([
      ...allowedRedirectOrigins,
      ...(successOrigin ? [successOrigin] : []),
      ...(defaultOrigin ? [defaultOrigin] : []),
      ...(apiBaseOrigin ? [apiBaseOrigin] : []),
    ])
  );

  return {
    key: 'github',
    displayName: 'GitHub',
    strategyName: 'github',
    enabled: Boolean(clientId && clientSecret),
    clientId,
    clientSecret,
    callbackUrl: callback,
    scope: normalizeScope(process.env.GITHUB_SCOPE),
    successRedirect,
    failureRedirect,
    defaultRedirect,
    allowedRedirectOrigins: origins,
    defaultRedirectOrigin: defaultOrigin,
    stateMaxAgeMs,
    baseRedirectUrl: baseRedirect,
  };
};

export const buildOAuthConfig = (options: BuildProviderOptions): OAuthConfig => {
  const providers: Record<string, OAuthProviderConfig> = {};

  const github = buildGithubConfig(options);
  providers.github = github;

  const defaultProvider = github.enabled ? 'github' : undefined;

  return {
    providers,
    defaultProvider,
  };
};

export const isOAuthProviderEnabled = (config: OAuthProviderConfig): boolean => config.enabled;
