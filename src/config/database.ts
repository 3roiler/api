import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const poolConfig: PoolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number.parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'api_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: Number.parseInt(process.env.DB_MAX_CLIENTS || '20'),
  idleTimeoutMillis: Number.parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
  connectionTimeoutMillis: Number.parseInt(process.env.DB_CONNECTION_TIMEOUT || '2000'),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
};

export const pool = new Pool(poolConfig);

pool.on('connect', () => {
  console.log('✅ Database connected successfully');
});

pool.on('error', (err: Error) => {
  console.error('❌ Unexpected database error:', err);
  process.exit(-1);
});

process.on('SIGINT', async () => {
  await pool.end();
  console.log('Database connection pool closed');
  process.exit(0);
});

export default pool;
