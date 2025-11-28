import { Pool } from 'pg';
import { createClient } from 'redis';
import config from './config';

async function onError(err?: Error) {
  const millis = Date.now();
  await cache.quit();
  await database.end();

  console.error('UNHANDLED ERROR. Took ' + (Date.now() - millis) + 'ms to shutdown.', err);
  process.exit(5);
}

const database = new Pool({
  connectionString: config.databaseUrl
});

const cache = createClient({
  url: config.redisUrl
})
  .on("error", async (err) => {
    await onError(err);
  });

cache.connect().catch(async (err) => {
  await onError(err);
});

database.on('error', async (err: Error) => {
  await onError(err);
});

process.on('SIGINT', onError);

export default { database, cache };