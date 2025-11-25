import { Pool } from 'pg';
import config from './config';

export const pool = new Pool({
    connectionString: config.databaseUrl
});

pool.on('error', (err: Error) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

process.on('SIGINT', async () => {
  const millis = new Date().getTime();
  console.log('SIGINT received: closing...');
  await pool.end();
  console.log('Database connection pool closed. Took ', new Date().getTime() - millis, 'ms');
  process.exit(0);
});

export default { pool };