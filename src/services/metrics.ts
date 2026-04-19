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
/**
 * Hard upper bound for every outbound DO call. DO's monitoring endpoints
 * occasionally sit on requests for 30+ seconds; without a timeout our
 * handler hangs past the DO App Platform ingress's 60 s gateway timeout
 * and the client sees a bare 504 *without* CORS headers — which the
 * browser then surfaces as a misleading CORS error. Failing fast here
 * keeps the error inside our own pipeline where we can decorate it with
 * a clean identifier + CORS.
 */
const DO_FETCH_TIMEOUT_MS = 10_000;

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

export type ConfiguredApp = { id: string; label: string };

/**
 * Read the list of DigitalOcean apps the operator wants to monitor.
 *
 * Canonical storage is `digitalocean.apps`, a JSON array of
 * `{id, label}` (order preserved = UI order). The legacy single-value
 * `digitalocean.app_id` is still honoured as a one-element fallback so an
 * existing deployment doesn't break the moment this ships — the user can
 * migrate at their leisure via the Settings UI.
 *
 * Every entry is normalised: trimmed, no empties, `label` defaults to the
 * first 8 chars of the UUID so the UI always has something to render.
 */
async function getConfiguredApps(): Promise<ConfiguredApp[]> {
  const raw = await settingsService.getSettingValue<unknown>('digitalocean.apps', null);
  if (Array.isArray(raw)) {
    const normalised = raw
      .map((entry): ConfiguredApp | null => {
        if (!entry || typeof entry !== 'object') return null;
        const id = typeof (entry as { id?: unknown }).id === 'string'
          ? ((entry as { id: string }).id).trim()
          : '';
        if (!id) return null;
        const labelRaw = (entry as { label?: unknown }).label;
        const label = typeof labelRaw === 'string' && labelRaw.trim().length > 0
          ? labelRaw.trim()
          : id.slice(0, 8);
        return { id, label };
      })
      .filter((x): x is ConfiguredApp => x !== null);
    if (normalised.length > 0) return normalised;
  }

  // Legacy fallback: pre-multi-app deployments stored a single UUID under
  // `digitalocean.app_id`. Keep reading it so migrations are a UI step,
  // not a deploy step.
  const legacy = await settingsService.getSettingValue<unknown>('digitalocean.app_id', null);
  if (typeof legacy === 'string' && legacy.trim().length > 0) {
    const id = legacy.trim();
    return [{ id, label: 'App' }];
  }

  throw AppError.serviceUnavailable(
    'DigitalOcean apps not configured. Set `digitalocean.apps` (array of {id, label}) in the dashboard settings.',
    'METRICS_NOT_CONFIGURED'
  );
}

/**
 * Ensure `appId` is one of the configured apps before we turn it into a
 * DO API call. Without this the `:appId` path param would let any caller
 * use our stored PAT to probe arbitrary DO resources — a small but real
 * token-leak vector.
 */
async function assertAppConfigured(appId: string): Promise<ConfiguredApp> {
  const apps = await getConfiguredApps();
  const hit = apps.find((a) => a.id === appId);
  if (!hit) {
    throw AppError.notFound(
      `App ID ${appId} is not in the configured list.`,
      'METRICS_APP_NOT_CONFIGURED'
    );
  }
  return hit;
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
      },
      signal: AbortSignal.timeout(DO_FETCH_TIMEOUT_MS)
    });
  } catch (err) {
    // `AbortSignal.timeout` throws `TimeoutError` (a DOMException). Distinguish
    // it from connectivity errors so the UI can show "aufgegeben" vs
    // "nicht erreichbar".
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      console.error('DO API fetch timed out', { path, timeoutMs: DO_FETCH_TIMEOUT_MS });
      throw AppError.serviceUnavailable(
        `DigitalOcean API did not respond within ${DO_FETCH_TIMEOUT_MS / 1000}s.`,
        'METRICS_UPSTREAM_TIMEOUT'
      );
    }
    console.error('DO API fetch failed', { path, err });
    throw AppError.serviceUnavailable('Could not reach DigitalOcean API.', 'METRICS_UPSTREAM_UNREACHABLE');
  }

  if (res.status === 401 || res.status === 403) {
    // Scope problems are indistinguishable from "wrong token" at the HTTP
    // layer — both are 401/403 — so we point the user at both causes. The
    // monitoring endpoints specifically require `monitoring:read`; a token
    // that only has `app:read` + `database:read` will work for summary but
    // not for any time-series call.
    const body = await safeReadBody(res);
    console.error('DO API rejected token', { path, status: res.status, body });
    throw AppError.serviceUnavailable(
      'DigitalOcean API rejected the token. Check `digitalocean.token` in the dashboard settings and ensure the PAT has the `monitoring:read` scope.',
      'METRICS_AUTH_FAILED'
    );
  }
  if (res.status === 404) {
    // Body text sometimes carries a useful hint ("resource not found" vs
    // "invalid UUID format") — read it for the server log, but keep the
    // client-facing message stable.
    const body = await safeReadBody(res);
    console.error('DO API 404', { path, body });
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
    const body = await safeReadBody(res);
    console.error('DO API returned error', { path, status: res.status, body });
    throw AppError.serviceUnavailable(
      `DigitalOcean API returned ${res.status}.`,
      'METRICS_UPSTREAM_FAILED'
    );
  }
  return res.json() as Promise<T>;
}

/** Read a response body without throwing; only used for error logs. */
async function safeReadBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return '<unreadable>';
  }
}

/**
 * DO's monitoring spec is fussy about the two timestamp params: the canonical
 * names are `metric_timestamp_start` / `metric_timestamp_end` (the plain
 * `start`/`end` aliases work on some endpoints but not all), and values must
 * be unix seconds as **strings**. Returning a `URLSearchParams`-ready pair
 * keeps callers from reinventing that shape for each metric.
 */
function windowToRange(window: MetricWindow): {
  metric_timestamp_start: string;
  metric_timestamp_end: string;
} {
  const endSec = Math.floor(Date.now() / 1000);
  const hours = window === '24h' ? 24 : window === '6h' ? 6 : 1;
  const startSec = endSec - hours * 60 * 60;
  return {
    metric_timestamp_start: String(startSec),
    metric_timestamp_end: String(endSec)
  };
}

// ─── Public surface ────────────────────────────────────────────────────────

/**
 * Tell the UI up-front which bits of config are missing. `appsConfigured`
 * is a count (not a boolean) so the dashboard can render a per-app summary
 * without a second round trip just to learn the length.
 */
export async function getStatus(): Promise<{
  tokenConfigured: boolean;
  appsConfigured: number;
  databaseIdConfigured: boolean;
  refreshDefaultSeconds: number;
}> {
  const [tokenMeta, apps, databaseIdRow, refreshDefaultRaw] = await Promise.all([
    settingsService.getSecretMeta('digitalocean.token'),
    getConfiguredApps().catch(() => [] as ConfiguredApp[]),
    settingsService.getSetting<string>('digitalocean.database_id'),
    settingsService.getSettingValue<unknown>('metrics.refresh_default_seconds', 30)
  ]);

  const parsedRefresh = typeof refreshDefaultRaw === 'number'
    ? refreshDefaultRaw
    : Number(refreshDefaultRaw);

  return {
    tokenConfigured: tokenMeta !== null,
    appsConfigured: apps.length,
    databaseIdConfigured: typeof databaseIdRow?.value === 'string' && databaseIdRow.value.length > 0,
    refreshDefaultSeconds: Number.isFinite(parsedRefresh) && parsedRefresh > 0 ? parsedRefresh : 30
  };
}

/**
 * Public surface for the UI's app-selector: one small call returns every
 * configured app's `{id, label}`. Intentionally does not expose the DO
 * token or any per-app secret state.
 */
export async function listApps(): Promise<ConfiguredApp[]> {
  return getConfiguredApps();
}

export async function getAppSummary(appId: string): Promise<unknown> {
  const [token] = await Promise.all([getDoToken(), assertAppConfigured(appId)]);
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
  appId: string,
  metric: 'cpu_percentage' | 'memory_percentage',
  window: MetricWindow
): Promise<unknown> {
  const [token] = await Promise.all([getDoToken(), assertAppConfigured(appId)]);
  const range = windowToRange(window);
  const cacheKey = `${CACHE_PREFIX}app:${appId}:${metric}:${window}`;
  return fetchCached(cacheKey, async () => {
    const query = new URLSearchParams({ app_id: appId, ...range });
    return doFetch(`/monitoring/metrics/apps/${metric}?${query.toString()}`, token);
  });
}

/**
 * DO managed-database monitoring metrics. The public OpenAPI spec **only**
 * documents these paths for MySQL today (`/monitoring/metrics/database/mysql/
 * {cpu,memory,disk}_usage` with `db_id` as a query param and a required
 * `aggregate=avg` hint). There is no documented Postgres equivalent — for
 * Postgres clusters DO exposes metrics via a Prometheus scrape endpoint
 * instead. We call the MySQL path anyway on the theory that the backend may
 * accept any DBaaS cluster UUID; when it returns 404 the UI gets a clean
 * "Daten nicht verfügbar" card instead of a crash.
 */
const DB_METRIC_PATHS: Record<'cpu' | 'memory' | 'disk', string> = {
  cpu: 'cpu_usage',
  memory: 'memory_usage',
  disk: 'disk_usage'
};

export async function getDatabaseMetric(
  metric: 'cpu' | 'memory' | 'disk',
  window: MetricWindow
): Promise<unknown> {
  const [token, databaseId] = await Promise.all([getDoToken(), getDatabaseId()]);
  const range = windowToRange(window);
  const cacheKey = `${CACHE_PREFIX}db:${databaseId}:${metric}:${window}`;
  return fetchCached(cacheKey, async () => {
    const query = new URLSearchParams({
      db_id: databaseId,
      aggregate: 'avg',
      ...range
    });
    return doFetch(
      `/monitoring/metrics/database/mysql/${DB_METRIC_PATHS[metric]}?${query.toString()}`,
      token
    );
  });
}

export default {
  isValidWindow,
  getStatus,
  listApps,
  getAppSummary,
  getDatabaseSummary,
  getAppMetric,
  getDatabaseMetric
};
