import { Pool } from 'pg';
import { createClient } from 'redis';
import config from './config';

async function onError() {
  const millis = Date.now();
  await cache.quit();
  await database.end();
  console.log('Database connection pool closed. Took ', Date.now() - millis, 'ms');
  process.exit(0);
}

const database = new Pool({
  connectionString: config.databaseUrl
});

const cache = createClient({
  url: config.redisUrl
})
  .on("error", async (err) => {
    console.error("Cache error", err);
    await onError();
  });

cache.connect().catch(async (err) => {
  console.error("Cache connection error", err);
  await onError();
});

database.on('error', async (err: Error) => {
  console.error('Database error', err);
  await onError();
});

process.on('SIGINT', onError);

export default { database, cache };