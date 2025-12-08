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

// CONSIDERATION generic oauth config --> hardcode for now, because github is enough
const github = {
  clientId: process.env.GITHUB_CLIENT_ID || '',
  clientSecret: process.env.GITHUB_CLIENT_SECRET || ''
};

const providers = {
  github
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
  corsOrigin
};

export default config;

