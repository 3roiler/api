import dotenv from 'dotenv';

dotenv.config();

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const port = Number.parseInt(process.env.PORT || '3000', 10);
const prefix = process.env.API_PREFIX || '/api';
const url = process.env.API_URL || `http://localhost:${port}`;
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
  databaseUrl,
  redisUrl,
  contact,
  jwtSecret,
  jwtExpire,
  providers,
  corsOrigin,
  adminEmails,
  secretsKey
};

export default config;

