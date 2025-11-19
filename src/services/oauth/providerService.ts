import { AppError } from '../../middleware/index.js';
import config from '../../config/index.js';
import type { OAuthProviderConfig } from '../../types/oauth.js';

export const getOAuthProvider = (providerKey: string): OAuthProviderConfig => {
  const provider = config.oauth.providers[providerKey];

  if (!provider) {
    throw AppError.notFound(`OAuth provider "${providerKey}" is not supported.`);
  }

  return provider;
};

export const ensureProviderEnabled = (provider: OAuthProviderConfig): void => {
  if (!provider.enabled) {
    throw AppError.serviceUnavailable(`${provider.displayName} OAuth is not configured on the API.`);
  }
};
