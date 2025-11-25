import dotenv from 'dotenv';

dotenv.config();

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const port = Number.parseInt(process.env.PORT || '3000', 10);
const prefix = process.env.API_PREFIX || '/api';
const url = process.env.API_URL || `http://localhost:${port}`;
const databaseUrl = process.env.DATABASE_URL || '';
const redisUrl = process.env.REDIS_URL || '';
const contact = process.env.CONTACT_EMAIL || '';

// CONSIDERATION generic oauth config --> hardcode for now, because github is enough
const github = {
  clientId: process.env.GITHUB_CLIENT_ID || '',
  clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
  callbackUrl: process.env.GITHUB_CALLBACK_URL || '',
  scope: process.env.GITHUB_SCOPE?.split(',').map(s => s.trim()) || ['user:email']
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
  providers
};

export default config;

