import persistence from './persistence.js';
import settingsService from './settings.js';
import AppError from './error.js';

/**
 * Thin proxy in front of the DigitalOcean v2 API. Reads the operator-
 * configured token + resource IDs from the `app_secret` / `app_setting`
 * tables and caches every response in Redis for `CACHE_TTL_SECONDS` so the
 * dashboard auto-refresh on the web side doesn't chew through DO's 5 000
 * requests-per-hour quota.
 *
 * Design choices:
 *
 * - **Pass-through JSON.** We don't reshape the DO response because the
 *   frontend knows best what to render. Adding a typed layer here would
 *   only drift from DO's schema.
 *
 * - **Permissive cache.** A corrupted cache entry is just missed revenue —
 *   we catch the JSON parse and fetch fresh instead of failing the whole
 *   request. The freshly-fetched value overwrites the bad row.
 *
 * - **Clear 503s on config gaps.** When `digitalocean.token` isn't set or
 *   the app/db IDs are missing we return 503 + a specific identifier so
 *   the web UI can show "nicht konfiguriert" instead of a raw error.
 *
 * - **No long-lived in-memory state.** The DO token is read fresh on every
 *   call (decrypt is cheap) so rotating the secret via the Settings page
 *   takes effect on the next request, not after a process restart.
 */

const DO_API_BASE = 'https://api.digitalocean.com/v2';
const CACHE_PREFIX = 'metrics:';
const CACHE_TTL_SECONDS = 30;

export type MetricWindow = '1h' | '6h' | '24h';
const VALID_WINDOWS: readonly MetricWindow[] = ['1h', '6h', '24h'];

export function isValidWindow(w: string): w is MetricWindow {
  return (VALID_WINDOWS as readonly string[]).includes(w);
}

// ─── Config accessors ──────────────────────────────────────────────────────

async function getDoToken(): Promise<string> {
  const token = await settingsService.readSecret('digitalocean.token');
  if (!token) {
    throw AppError.serviceUnavailable(
      'DigitalOcean token not configured. Set `digitalocean.token` in the dashboard settings.',
      'METRICS_NOT_CONFIGURED'
    );
  }
  return token;
}

async function getAppId(): Promise<string> {
  const v = await settingsService.getSettingValue<unknown>('digitalocean.app_id', null);
  if (typeof v !== 'string' || v.length === 0) {
    throw AppError.serviceUnavailable(
      'DigitalOcean app_id not configured. Set `digitalocean.app_id` in the dashboard settings.',
      'METRICS_NOT_CONFIGURED'
    );
  }
  return v;
}

async function getDatabaseId(): Promise<string> {
  const v = await settingsService.getSettingValue<unknown>('digitalocean.database_id', null);
  if (typeof v !== 'string' || v.length === 0) {
    throw AppError.serviceUnavailable(
      'DigitalOcean database_id not configured. Set `digitalocean.database_id` in the dashboard settings.',
      'METRICS_NOT_CONFIGURED'
    );
  }
  return v;
}

// ─── Cache + DO fetch helpers ──────────────────────────────────────────────

async function fetchCached<T>(cacheKey: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = await persistence.cache.get(cacheKey);
  if (hit) {
    try {
      return JSON.parse(hit) as T;
    } catch {
      // Corrupted cache entry — re-fetch and overwrite below.
    }
  }
  const fresh = await fetcher();
  await persistence.cache.set(cacheKey, JSON.stringify(fresh), { EX: CACHE_TTL_SECONDS });
  return fresh;
}

async function doFetch<T = unknown>(path: string, token: string): Promise<T> {
  const url = `${DO_API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });
  } catch (err) {
    console.error('DO API fetch failed', { path, err });
    throw AppError.serviceUnavailable('Could not reach DigitalOcean API.', 'METRICS_UPSTREAM_UNREACHABLE');
  }

  if (res.status === 401 || res.status === 403) {
    throw AppError.serviceUnavailable(
      'DigitalOcean API rejected the token. Check `digitalocean.token` in the dashboard settings.',
      'METRICS_AUTH_FAILED'
    );
  }
  if (res.status === 404) {
    throw AppError.notFound(
      'DigitalOcean returned 404 for the requested resource. Check the configured app_id / database_id.',
      'METRICS_RESOURCE_NOT_FOUND'
    );
  }
  if (res.status === 429) {
    throw AppError.serviceUnavailable(
      'DigitalOcean API rate limit exceeded. Try again shortly.',
      'METRICS_RATE_LIMITED'
    );
  }
  if (!res.ok) {
    console.error('DO API returned error', { path, status: res.status });
    throw AppError.serviceUnavailable(
      `DigitalOcean API returned ${res.status}.`,
      'METRICS_UPSTREAM_FAILED'
    );
  }
  return res.json() as Promise<T>;
}

function windowToRange(window: MetricWindow): { start: string; end: string } {
  const endSec = Math.floor(Date.now() / 1000);
  const hours = window === '24h' ? 24 : window === '6h' ? 6 : 1;
  const startSec = endSec - hours * 60 * 60;
  // DO monitoring API expects unix seconds as strings.
  return { start: String(startSec), end: String(endSec) };
}

// ─── Public surface ────────────────────────────────────────────────────────

/** Tell the UI up-front which bits of config are missing. */
export async function getStatus(): Promise<{
  tokenConfigured: boolean;
  appIdConfigured: boolean;
  databaseIdConfigured: boolean;
  refreshDefaultSeconds: number;
}> {
  const [tokenMeta, appIdRow, databaseIdRow, refreshDefaultRaw] = await Promise.all([
    settingsService.getSecretMeta('digitalocean.token'),
    settingsService.getSetting<string>('digitalocean.app_id'),
    settingsService.getSetting<string>('digitalocean.database_id'),
    settingsService.getSettingValue<unknown>('metrics.refresh_default_seconds', 30)
  ]);

  const parsedRefresh = typeof refreshDefaultRaw === 'number'
    ? refreshDefaultRaw
    : Number(refreshDefaultRaw);

  return {
    tokenConfigured: tokenMeta !== null,
    appIdConfigured: typeof appIdRow?.value === 'string' && appIdRow.value.length > 0,
    databaseIdConfigured: typeof databaseIdRow?.value === 'string' && databaseIdRow.value.length > 0,
    refreshDefaultSeconds: Number.isFinite(parsedRefresh) && parsedRefresh > 0 ? parsedRefresh : 30
  };
}

export async function getAppSummary(): Promise<unknown> {
  const [token, appId] = await Promise.all([getDoToken(), getAppId()]);
  return fetchCached(`${CACHE_PREFIX}app:${appId}:summary`, async () =>
    doFetch(`/apps/${encodeURIComponent(appId)}`, token)
  );
}

export async function getDatabaseSummary(): Promise<unknown> {
  const [token, databaseId] = await Promise.all([getDoToken(), getDatabaseId()]);
  return fetchCached(`${CACHE_PREFIX}db:${databaseId}:summary`, async () =>
    doFetch(`/databases/${encodeURIComponent(databaseId)}`, token)
  );
}

/**
 * DO app-platform monitoring metrics. `metric` selects between CPU / memory;
 * the endpoint path matches DO's `/monitoring/metrics/apps/<metric>` family.
 */
export async function getAppMetric(
  metric: 'cpu_percentage' | 'memory_percentage',
  window: MetricWindow
): Promise<unknown> {
  const [token, appId] = await Promise.all([getDoToken(), getAppId()]);
  const { start, end } = windowToRange(window);
  const cacheKey = `${CACHE_PREFIX}app:${appId}:${metric}:${window}`;
  return fetchCached(cacheKey, async () => {
    const query = new URLSearchParams({ app_id: appId, start, end });
    return doFetch(`/monitoring/metrics/apps/${metric}?${query.toString()}`, token);
  });
}

/**
 * DO managed-database monitoring metrics. `metric` maps to DO's
 * `cpu_usage`, `memory_usage`, or `disk_usage` family on
 * `/monitoring/metrics/database/*`.
 */
export async function getDatabaseMetric(
  metric: 'cpu' | 'memory' | 'disk',
  window: MetricWindow
): Promise<unknown> {
  const [token, databaseId] = await Promise.all([getDoToken(), getDatabaseId()]);
  const { start, end } = windowToRange(window);
  const cacheKey = `${CACHE_PREFIX}db:${databaseId}:${metric}:${window}`;
  return fetchCached(cacheKey, async () => {
    const query = new URLSearchParams({ host_id: databaseId, start, end });
    return doFetch(`/monitoring/metrics/database/${metric}?${query.toString()}`, token);
  });
}

export default {
  isValidWindow,
  getStatus,
  getAppSummary,
  getDatabaseSummary,
  getAppMetric,
  getDatabaseMetric
};
