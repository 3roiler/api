import { Pool } from 'pg';
import { createClient } from 'redis';
import config from './config';

/**
 * Persistence-Backends — eine Postgres-Pool und ein Redis-Client.
 *
 * Fehler-Politik:
 * - **Postgres-Pool-Errors**: sofortiger Shutdown. Diese Errors sind bei
 *   `pg.Pool` selten und signalisieren in der Regel einen wirklich
 *   kaputten Connection-Pool — der Prozess sollte sterben, damit der
 *   Orchestrator neu startet.
 * - **Redis-Errors**: sliding-window. Transiente Netzwerk-Hickser oder
 *   kurze Failovers lösen kein `process.exit` mehr aus (der Restart-
 *   Loop bei sustained Redis-Instabilität hat hier mehrfach Outages
 *   verschlimmert). Erst wenn `REDIS_ERROR_THRESHOLD` Fehler innerhalb
 *   eines `REDIS_ERROR_WINDOW_MS`-Fensters auftreten, geben wir auf
 *   und exiten — danach übernimmt der Orchestrator.
 * - **`SIGINT`**: sofortiger graceful shutdown (Strg-C in dev).
 *
 * Trade-off: während Redis intermittierend ist, können
 * Auth-Revocation-Lookups stale werden (Token, das eben revoked wurde,
 * kann kurz noch validieren). Akzeptabel, weil JWT-TTL ≤ 24h ist und
 * die alte "exit-on-any-error"-Variante strikt schlechter war — sie
 * hat ALLE laufenden Requests gekillt, nicht nur die Revocation-
 * Pfade.
 */

const REDIS_ERROR_WINDOW_MS = 60_000;
const REDIS_ERROR_THRESHOLD = 10;

/** Timestamps der letzten Redis-Errors im Sliding-Window. */
const redisErrorTimestamps: number[] = [];

/**
 * `shuttingDown` ist eine Idempotenz-Bremse: `shutdown` wird in
 * mehreren Code-Pfaden aufgerufen (Redis-Schwelle, Postgres-Error,
 * SIGINT), und nodes Event-Loop schickt durchaus zwei davon hinter-
 * einander. Ohne das Flag würde der zweite Aufruf auf bereits
 * geschlossene Clients ein zweites Quit-Statement feuern und Logs
 * mit Folgefehlern voll spammen.
 */
let shuttingDown = false;

async function shutdown(err: Error | undefined, source: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  const millis = Date.now();
  // `quit`/`end` werfen, wenn der Client schon down ist — wir wollen
  // trotzdem das Gegenstück aufräumen, daher Einzel-try-catch.
  try { await cache.quit(); } catch { /* already closed */ }
  try { await database.end(); } catch { /* already ended */ }
  console.error(`[${source}] shutdown after ${Date.now() - millis}ms.`, err ?? '');
  process.exit(5);
}

function noteRedisError(err: unknown) {
  if (shuttingDown) return;
  const now = Date.now();
  // Cull out-of-window entries vom Anfang des Arrays. Sliding window
  // bleibt damit O(1) amortisiert; wir trimmen nur die alten Einträge,
  // die wir bei diesem Aufruf eh anschauen müssen.
  while (
    redisErrorTimestamps.length > 0 &&
    (redisErrorTimestamps[0] ?? 0) < now - REDIS_ERROR_WINDOW_MS
  ) {
    redisErrorTimestamps.shift();
  }
  redisErrorTimestamps.push(now);
  const inWindow = redisErrorTimestamps.length;
  console.error(
    `[redis] error (${inWindow}/${REDIS_ERROR_THRESHOLD} im ${REDIS_ERROR_WINDOW_MS}ms-Fenster)`,
    err ?? ''
  );
  if (inWindow >= REDIS_ERROR_THRESHOLD) {
    void shutdown(
      err instanceof Error ? err : new Error('Redis error threshold exceeded'),
      'redis'
    );
  }
}

const database = new Pool({
  connectionString: config.databaseUrl
});

const cache = createClient({
  url: config.redisUrl
}).on('error', noteRedisError);

// `cache.connect()` löst beim Initial-Connect-Fail ein Reject aus; der
// `redis`-Client würde danach selbst neu verbinden, aber wir wollen
// das Failure trotzdem ins Sliding-Window einrechnen, damit ein
// permanenter Misfit (z. B. falsche `REDIS_URL`) am Boot nicht
// stillschweigend ignoriert wird.
cache.connect().catch(noteRedisError);

database.on('error', async (err: Error) => {
  await shutdown(err, 'pg');
});

process.on('SIGINT', () => {
  void shutdown(undefined, 'sigint');
});

export default { database, cache };
