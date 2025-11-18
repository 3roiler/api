import dotenv from 'dotenv';

dotenv.config();

const port = Number.parseInt(process.env.PORT || '3000', 10);
const apiPrefix = process.env.API_PREFIX || '/api';
const apiBaseUrl = process.env.API_BASE_URL || `http://localhost:${port}`;

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const normalizeScope = (scope?: string): string[] => {
  if (!scope) {
    return ['read:user', 'user:email'];
  }

  return scope
    .split(/[ ,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const jwtCookieMaxAgeMs = parseNumber(process.env.JWT_COOKIE_MAX_AGE_MS);

export const config = {
  port,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
  apiPrefix,
  apiBaseUrl,

  database: {
    host: process.env.DB_HOST || 'localhost',
    port: Number.parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'api_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  },
  
  rateLimit: {
    windowMs: Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },

  session: {
    secret: process.env.SESSION_SECRET || 'change-me-session-secret',
    cookieName: process.env.SESSION_COOKIE_NAME || 'broiler.sid',
    cookieDomain: process.env.SESSION_COOKIE_DOMAIN || undefined,
    secureCookie: (process.env.SESSION_SECURE_COOKIE || '').toLowerCase() === 'true',
  },

  oauth: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      callbackUrl: process.env.GITHUB_CALLBACK_URL || `${apiBaseUrl}${apiPrefix}/auth/github/callback`,
      scope: normalizeScope(process.env.GITHUB_SCOPE),
      successRedirect: process.env.GITHUB_SUCCESS_REDIRECT || '',
      failureRedirect: process.env.GITHUB_FAILURE_REDIRECT || '',
    },
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-jwt-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
    cookieName: process.env.JWT_COOKIE_NAME || 'broiler_token',
    cookieDomain: process.env.JWT_COOKIE_DOMAIN || undefined,
    cookieMaxAgeMs: jwtCookieMaxAgeMs,
    secureCookie: (process.env.JWT_SECURE_COOKIE || '').toLowerCase() === 'true',
  },
};

export default config;
