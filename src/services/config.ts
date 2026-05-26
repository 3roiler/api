import dotenv from 'dotenv';

// Runtime: Node 26+ erwartet (Dockerfile + devcontainer.json sind in
// IDEA-02 harmonisiert). Ältere Major-Versionen bauen evtl. noch, aber
// die in IDEA-12 geplante Sentry-Integration setzt diagnostics_channel-
// APIs voraus, die erst ab Node 24+ vollständig stabilisiert sind.
dotenv.config();

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const port = Number.parseInt(process.env.PORT || '3000', 10);
const prefix = process.env.API_PREFIX || '/api';
const url = process.env.API_URL || `http://localhost:${port}`;
// Host used as the cookie `Domain` (host-only): `api.broiler.dev` in prod,
// `localhost` in dev. Mirrors the inline derivation already used for the
// `access_token` cookie so CSRF/auth cookies share the same scope.
const cookieDomain = url.replace(/^https?:\/\//, '').split(':')[0];
// Public-facing frontend origin (e.g. `https://broiler.dev`). Used to build
// fixed OAuth `redirect_uri` values that match what's registered with
// GitHub/Twitch — must NOT come from the request (Referer/redirect_uri were
// open-redirect-able). Defaults to the first CORS-whitelist entry; in dev
// without CORS_ORIGIN it falls back to the local Vite dev server.
const webUrl = (process.env.WEB_URL
  || (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .find(s => s && s !== '*')
  || 'http://localhost:5173').replace(/\/$/, '');
const databaseUrl = process.env.DATABASE_URL || '';
const redisUrl = process.env.REDIS_URL || '';
const contact = process.env.CONTACT_EMAIL || '';
const corsOrigin = process.env.CORS_ORIGIN || '*';

// Users whose email matches this value get `blog.write` granted at startup.
// Comma-separated list. Leave empty to disable auto-seeding.
const adminEmails = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const jwtSecret = process.env.JWT_SECRET || (() => {
  const length = 256;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';

  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  for (const element of buf) { 
    s += chars[element % chars.length]; 
  }

  return s;
})();

const jwtExpire = Number(process.env.JWT_EXPIRE) || 24 * 60 * 60 * 1000; // 24 hours

/**
 * 32-byte symmetric key (base64) used to AES-GCM-encrypt every row in
 * `app_secret`. Generate once with `openssl rand -base64 32` and store as
 * an encrypted env var in DigitalOcean. Left empty in dev — the crypto
 * service will surface a clear error the first time anyone tries to
 * read/write a secret, rather than booting into a broken state that
 * silently corrupts data.
 */
const secretsKey = process.env.SECRETS_KEY || '';

/**
 * Upper bound (in bytes) for a single G-code upload. Enforced at the
 * route level via `express.raw({ limit })` and re-checked in the service
 * before the bytea insert, so a stray client bypass still hits the wall.
 * Default 50 MiB — covers hobby-scale prints comfortably while keeping
 * memory pressure predictable (the whole blob lives in RAM during upload).
 */
const gcodeMaxBytes = Number.parseInt(process.env.GCODE_MAX_BYTES || '52428800', 10);

const github = {
  clientId: process.env.GITHUB_CLIENT_ID || '',
  clientSecret: process.env.GITHUB_CLIENT_SECRET || ''
};

const twitch = {
  clientId: process.env.TWITCH_CLIENT_ID || '',
  clientSecret: process.env.TWITCH_CLIENT_SECRET || ''
};

const providers = {
  github,
  twitch
};

export const config = {
  isProduction,
  port,
  prefix,
  url,
  webUrl,
  cookieDomain,
  databaseUrl,
  redisUrl,
  contact,
  jwtSecret,
  jwtExpire,
  providers,
  corsOrigin,
  adminEmails,
  secretsKey,
  gcodeMaxBytes
};

export default config;

