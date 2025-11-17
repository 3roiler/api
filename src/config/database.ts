import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: process.env.DATABASE_POOL_SIZE ? Number.parseInt(process.env.DATABASE_POOL_SIZE) : 10,
};

export const pool = new Pool(poolConfig);

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