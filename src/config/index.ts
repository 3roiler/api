import dotenv from 'dotenv';
import { parseBoolean, parseNumber } from '../utils/env.js';
import { parseOriginList } from '../utils/url.js';
import { buildOAuthConfig } from './oauth.js';

dotenv.config();

const port = Number.parseInt(process.env.PORT || '3000', 10);
const apiPrefix = process.env.API_PREFIX || '/api';
const apiBaseUrl = process.env.API_BASE_URL || `http://localhost:${port}`;
const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const jwtCookieMaxAgeMs = parseNumber(process.env.JWT_COOKIE_MAX_AGE_MS);
const refreshTokenTtlMs = parseNumber(process.env.REFRESH_TOKEN_TTL_MS) ?? 30 * 24 * 60 * 60 * 1000;
const refreshCookieMaxAgeMs = parseNumber(process.env.REFRESH_COOKIE_MAX_AGE_MS) ?? refreshTokenTtlMs;
const refreshRotationGraceMs = parseNumber(process.env.REFRESH_ROTATION_GRACE_MS) ?? 5 * 60 * 1000;

const oauth = buildOAuthConfig({ apiBaseUrl, apiPrefix });
const providerOrigins = Object.values(oauth.providers).flatMap((provider) => provider.allowedRedirectOrigins);
const corsAllowedOrigins = parseOriginList(process.env.CORS_ALLOWED_ORIGINS);
const corsOrigins = Array.from(new Set([...corsAllowedOrigins, ...providerOrigins]));

const sessionSecureEnv = parseBoolean(process.env.SESSION_SECURE_COOKIE);
const jwtSecureEnv = parseBoolean(process.env.JWT_SECURE_COOKIE);
const refreshSecureEnv = parseBoolean(process.env.REFRESH_SECURE_COOKIE);
const allowCredentials = parseBoolean(process.env.CORS_ALLOW_CREDENTIALS) ?? true;

export const config = {
  port,
  nodeEnv,
  isProduction,
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
    secureCookie: sessionSecureEnv ?? isProduction,
  },

  oauth: {
    ...oauth,
    github: oauth.providers.github,
  },

  cors: {
    allowedOrigins: corsOrigins,
    allowCredentials,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-jwt-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
    cookieName: process.env.JWT_COOKIE_NAME || 'broiler_token',
    cookieDomain: process.env.JWT_COOKIE_DOMAIN || undefined,
    cookieMaxAgeMs: jwtCookieMaxAgeMs,
    secureCookie: jwtSecureEnv ?? isProduction,
  },

  refreshToken: {
    cookieName: process.env.REFRESH_COOKIE_NAME || 'broiler_refresh',
    cookieDomain: process.env.REFRESH_COOKIE_DOMAIN || undefined,
    cookieMaxAgeMs: refreshCookieMaxAgeMs,
    secureCookie: refreshSecureEnv ?? isProduction,
    tokenTtlMs: refreshTokenTtlMs,
    rotationGraceMs: refreshRotationGraceMs,
  },
};

export default config;
