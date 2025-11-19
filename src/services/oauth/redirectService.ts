import type { Request } from 'express';
import type { OAuthProviderConfig } from '../../types/oauth.js';
import { AppError } from '../../middleware/index.js';

const toStringOrUndefined = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const firstString = value.find((entry): entry is string => typeof entry === 'string');

    if (firstString) {
      return firstString;
    }
  }

  return undefined;
};

const isHttpProtocol = (protocol: string): boolean => ['http:', 'https:'].includes(protocol);

export const resolveRedirectTarget = (req: Request, provider: OAuthProviderConfig): string | null => {
  const raw = toStringOrUndefined(req.query.redirect)?.trim();

  if (!raw) {
    return null;
  }

  const base = provider.defaultRedirect || provider.successRedirect || provider.baseRedirectUrl;

  if (!base) {
    throw AppError.badRequest('Redirect target is not allowed for this OAuth provider.');
  }

  let targetUrl: URL;

  try {
    targetUrl = new URL(raw);
  } catch {
    try {
      targetUrl = new URL(raw, base);
    } catch {
      throw AppError.badRequest('Invalid redirect target provided.');
    }
  }

  if (!isHttpProtocol(targetUrl.protocol)) {
    throw AppError.badRequest('Redirect target must use HTTP or HTTPS.');
  }

  if (
    provider.allowedRedirectOrigins.length > 0 &&
    !provider.allowedRedirectOrigins.includes(targetUrl.origin)
  ) {
    throw AppError.badRequest('Redirect target is not in the allowed list.');
  }

  return targetUrl.toString();
};
