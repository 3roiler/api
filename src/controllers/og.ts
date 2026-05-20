import { Request, Response, NextFunction } from 'express';
import { clip as clipService, blog as blogService } from '../services/index.js';

/**
 * Open-Graph-Rendering für Social-Crawler (WhatsApp, Discord, X, …), die
 * KEIN JavaScript ausführen und daher von der SPA nur die generische
 * index.html sehen würden. Caddy leitet ausschließlich Crawler-Requests
 * (per User-Agent) für teilbare Pfade hierher um; echte Nutzer bekommen
 * weiterhin die SPA. So zeigt eine geteilte Clip-/Artikel-URL den richtigen
 * Titel + das passende Bild.
 */
const SITE = 'https://broiler.dev';
const DEFAULT_IMAGE = 'https://broiler.fra1.cdn.digitaloceanspaces.com/og-image.png';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** HTML-escape für sichere Interpolation (Clip-Titel stammen von Twitch). */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Nur https-Bilder zulassen (kein javascript:/data: …); sonst Default. */
function safeImage(url: string | null | undefined): string {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : DEFAULT_IMAGE;
}

interface OgData {
  title: string;
  description: string;
  url: string;
  image: string;
  type: 'website' | 'article' | 'video.other';
  /** Optionaler Inline-Player (Discord/X): iframe-Embed-URL + Maße. */
  video?: { url: string; width: number; height: number };
}

function renderOg(d: OgData): string {
  const title = esc(`${d.title} · broiler.dev`);
  const desc = esc(d.description);
  const url = esc(d.url);
  const image = esc(d.image);
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="${d.type}">
<meta property="og:site_name" content="broiler.dev">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${image}">
<meta property="og:locale" content="de_DE">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${image}">${d.video ? `
<meta property="og:video" content="${esc(d.video.url)}">
<meta property="og:video:secure_url" content="${esc(d.video.url)}">
<meta property="og:video:type" content="text/html">
<meta property="og:video:width" content="${d.video.width}">
<meta property="og:video:height" content="${d.video.height}">
<meta name="twitter:player" content="${esc(d.video.url)}">
<meta name="twitter:player:width" content="${d.video.width}">
<meta name="twitter:player:height" content="${d.video.height}">` : ''}
</head>
<body><p><a href="${url}">${title}</a></p></body>
</html>`;
}

function sendOg(res: Response, html: string) {
  // `no-store` + `Vary: User-Agent`: verhindert, dass ein Shared-Cache
  // (Cloudflare) diese Crawler-Antwort einem echten Nutzer ausliefert.
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('Vary', 'User-Agent');
  return res.status(200).send(html);
}

/** GET /og/streamclips/clip/:id — OG für einen freigegebenen Clip. */
const clip = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return next(); // → 404-Handler
    const c = await clipService.getById(id);
    if (!c || c.status !== 'approved') return next();
    const broadcaster = c.broadcasterName ?? 'Twitch';
    const cat = c.categoryName ? ` · ${c.categoryName}` : '';
    // Twitch-Clip-Embed mit den Domains, unter denen das Iframe laufen soll
    // (broiler.dev + Discord-Clients). Discord rendert daraus ggf. einen
    // Inline-Player; klappt der parent-Check nicht, bleibt die Bild-Vorschau.
    const embedUrl =
      `https://clips.twitch.tv/embed?clip=${encodeURIComponent(c.twitchClipId)}` +
      '&parent=broiler.dev&parent=discord.com&parent=discordapp.com&parent=www.discord.com&autoplay=false';
    return sendOg(res, renderOg({
      title: c.title,
      description: `Clip von ${broadcaster}${cat} — bewertet auf Streamclips Germany.`,
      url: `${SITE}/streamclips/clip/${id}`,
      image: safeImage(c.thumbnailUrl),
      type: 'video.other',
      video: { url: embedUrl, width: 640, height: 360 }
    }));
  } catch (err) {
    return next(err);
  }
};

/** GET /og/blog/:slug — OG für einen veröffentlichten, öffentlichen Beitrag. */
const post = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug);
    const p = await blogService.getPostBySlug(slug); // nur published + public
    if (!p) return next();
    return sendOg(res, renderOg({
      title: p.title,
      description: p.excerpt ?? `Blog-Beitrag von Paul Wechselberger: ${p.title}.`,
      url: `${SITE}/blog/${encodeURIComponent(slug)}`,
      image: DEFAULT_IMAGE,
      type: 'article'
    }));
  } catch (err) {
    return next(err);
  }
};

export default { clip, post };
