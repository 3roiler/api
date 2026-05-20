import config from './config.js';
import persistence from './persistence.js';
import AppError from './error.js';

/**
 * Twitch-Clip-Anbindung für Streamclips Germany.
 *
 * Nutzt den App-Access-Token-Flow (client_credentials) — kein
 * User-Token nötig, um öffentliche Clip-Metadaten zu lesen. Das Token
 * wird in Redis gecacht (Twitch gibt ~60 Tage Gültigkeit, wir cachen
 * mit Sicherheitspuffer), damit nicht jeder Einreich-Vorgang ein
 * frisches Token zieht.
 *
 * Der parallele User-OAuth-Flow für Login lebt weiterhin in
 * `routes/twitch.ts` / `services/auth.ts` und bleibt unberührt.
 */
const TWITCH_API_BASE = 'https://api.twitch.tv/helix';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const APP_TOKEN_CACHE_KEY = 'twitch:app_token';

/**
 * Erlaubte Zeichen in einem Clip-Slug. Der Slug landet später roh in
 * der Helix-Query und in der iframe-`clip`-URL, daher streng auf
 * URL-sichere Zeichen begrenzt.
 */
const SLUG_RE = /^[A-Za-z0-9_-]{2,120}$/;

const ALLOWED_HOSTS = new Set([
  'clips.twitch.tv',
  'www.twitch.tv',
  'twitch.tv',
  'm.twitch.tv'
]);

export interface TwitchClipMeta {
  id: string;
  url: string;
  embedUrl: string;
  broadcasterId: string;
  broadcasterName: string;
  creatorName: string;
  gameId: string | null;
  language: string;
  title: string;
  viewCount: number;
  createdAt: string;
  thumbnailUrl: string;
  duration: number;
}

export interface TwitchGameMeta {
  id: string;
  name: string;
  boxArtUrl: string | null;
}

/**
 * Extrahiert den Clip-Slug aus einer Twitch-URL oder akzeptiert einen
 * bereits rohen Slug. Gibt `null` zurück, wenn die Eingabe keine
 * Twitch-Clip-Referenz ist — der Controller macht daraus einen 400.
 *
 * Akzeptiert:
 *   - clips.twitch.tv/{slug}
 *   - (www.|m.)twitch.tv/{channel}/clip/{slug}
 *   - roher {slug}
 * Fremd-Domains werden bewusst abgelehnt (kein offener Redirect /
 * keine fremden iframes).
 */
export function parseClipId(input: string): string | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Keine URL — als roher Slug interpretieren.
    return SLUG_RE.test(trimmed) ? trimmed : null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split('/').filter(Boolean);

  if (url.hostname.toLowerCase() === 'clips.twitch.tv') {
    const slug = segments[0];
    return slug && SLUG_RE.test(slug) ? slug : null;
  }

  // twitch.tv/{channel}/clip/{slug}
  const clipIdx = segments.indexOf('clip');
  if (clipIdx >= 0 && segments[clipIdx + 1]) {
    const slug = segments[clipIdx + 1];
    return SLUG_RE.test(slug) ? slug : null;
  }

  return null;
}

export class TwitchClipService {
  /**
   * App-Access-Token (client_credentials), Redis-gecacht. Wirft einen
   * sprechenden 503, wenn die Twitch-Credentials fehlen oder Twitch
   * den Token verweigert — statt später mit kryptischem 401 auf
   * /clips zu scheitern.
   */
  private async getAppAccessToken(): Promise<string> {
    const cached = await persistence.cache.get(APP_TOKEN_CACHE_KEY);
    if (cached) return cached;

    const { clientId, clientSecret } = config.providers.twitch;
    if (!clientId || !clientSecret) {
      throw AppError.serviceUnavailable(
        'Twitch ist nicht konfiguriert (TWITCH_CLIENT_ID/SECRET fehlen).',
        'TWITCH_NOT_CONFIGURED'
      );
    }

    const res = await fetch(TWITCH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials'
      })
    });

    if (!res.ok) {
      throw AppError.serviceUnavailable('Twitch-Authentifizierung fehlgeschlagen.', 'TWITCH_AUTH_FAILED');
    }

    const data = (await res.json()) as { access_token: string; expires_in?: number };
    const ttl = Math.max(60, (data.expires_in ?? 3600) - 60);
    await persistence.cache.set(APP_TOKEN_CACHE_KEY, data.access_token, { EX: ttl });
    return data.access_token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getAppAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      'Client-Id': config.providers.twitch.clientId
    };
  }

  /**
   * Holt die Metadaten eines Clips. `null`, wenn Twitch den Clip nicht
   * (mehr) kennt — der Controller macht daraus einen 404, statt einen
   * Geister-Clip anzulegen.
   */
  async fetchClipMeta(clipId: string): Promise<TwitchClipMeta | null> {
    const res = await fetch(`${TWITCH_API_BASE}/clips?id=${encodeURIComponent(clipId)}`, {
      headers: await this.authHeaders()
    });
    if (!res.ok) {
      throw AppError.serviceUnavailable('Twitch-Clip-Abruf fehlgeschlagen.', 'TWITCH_CLIP_FETCH_FAILED');
    }

    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const c = data.data?.[0];
    if (!c) return null;

    return {
      id: String(c.id),
      url: String(c.url ?? ''),
      embedUrl: String(c.embed_url ?? ''),
      broadcasterId: String(c.broadcaster_id ?? ''),
      broadcasterName: String(c.broadcaster_name ?? ''),
      creatorName: String(c.creator_name ?? ''),
      gameId: c.game_id ? String(c.game_id) : null,
      language: String(c.language ?? ''),
      title: String(c.title ?? ''),
      viewCount: Number(c.view_count ?? 0),
      createdAt: String(c.created_at ?? ''),
      thumbnailUrl: String(c.thumbnail_url ?? ''),
      duration: Number(c.duration ?? 0)
    };
  }

  /**
   * Holt Kategorie-Stammdaten (Spiel). Kategorie ist optional — bei
   * Fehler `null` statt Exception, damit ein Clip auch ohne aufgelöste
   * Kategorie einreichbar bleibt.
   */
  async fetchCategory(gameId: string): Promise<TwitchGameMeta | null> {
    try {
      const res = await fetch(`${TWITCH_API_BASE}/games?id=${encodeURIComponent(gameId)}`, {
        headers: await this.authHeaders()
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
      const g = data.data?.[0];
      if (!g) return null;
      return {
        id: String(g.id),
        name: String(g.name ?? ''),
        boxArtUrl: g.box_art_url ? String(g.box_art_url) : null
      };
    } catch {
      return null;
    }
  }
}

export default new TwitchClipService();
