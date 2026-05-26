import { Request, Response, NextFunction } from 'express';
import { blog as blogService, clip as clipService } from '../services/index.js';
import { shortidFromId } from '../services/clip.js';

/**
 * RSS-2.0-Feed für den Blog. Liefert die letzten 20 veröffentlichten,
 * öffentlichen Posts. Caddy proxyt `/blog/rss.xml` hierher (gleiche
 * Ausnahme wie für `/sitemap.xml` — Frontend ist ein SPA, dynamische
 * XML-Endpunkte gehören in die API). Wir geben Cache-Control: 1h
 * mit, damit Feed-Reader nicht jede Minute anfragen.
 */
const SITE = 'https://broiler.dev';

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RFC-822-Datum für RSS (z. B. „Tue, 03 Jun 2025 09:39:21 GMT"). */
function rfc822(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toUTCString();
}

/**
 * RSS-2.0-Feed für Streamclips Germany. Die letzten 30 freigegebenen
 * Clips, sortiert nach dem Twitch-Erstellungsdatum (mit Fallback auf
 * das broiler-Submit-Datum). Caddy proxyt `/streamclips/rss.xml`
 * hierher. Selbe Struktur wie der Blog-Feed, andere Daten + Quelle.
 */
const clipFeed = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const clips = await clipService.listApprovedForRss(30);

    const itemsXml = clips
      .map((c) => {
        const link = `${SITE}/streamclips/clip/${c.slug}-${shortidFromId(c.id)}`;
        const pubDate = rfc822(c.clipCreatedAt ?? c.createdAt);
        // Description: Streamer + Twitch-Kategorie + Creator, sofern bekannt.
        // Bewusst Plain-Text — RSS-Reader rendern hier sehr unterschiedlich
        // (manche escapen HTML, manche nicht), daher der konservative Pfad.
        const descParts: string[] = [];
        if (c.broadcasterName) descParts.push(`Clip von ${c.broadcasterName}`);
        if (c.creatorName && c.creatorName !== c.broadcasterName) {
          descParts.push(`geclippt von ${c.creatorName}`);
        }
        descParts.push('auf Streamclips Germany');
        const description = `${descParts.join(' — ')}.`;
        return [
          '    <item>',
          `      <title>${xmlEscape(c.title)}</title>`,
          `      <link>${link}</link>`,
          `      <guid isPermaLink="true">${link}</guid>`,
          pubDate ? `      <pubDate>${pubDate}</pubDate>` : '',
          `      <description>${xmlEscape(description)}</description>`,
          '    </item>'
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n');

    const lastBuild =
      clips
        .map((c) => c.updatedAt ?? c.clipCreatedAt ?? c.createdAt)
        .filter((v): v is Date => v != null)
        .map((v) => v.getTime())
        .reduce((a, b) => Math.max(a, b), 0) || Date.now();

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
      `  <channel>\n` +
      `    <title>Streamclips Germany — broiler.dev</title>\n` +
      `    <link>${SITE}/streamclips</link>\n` +
      `    <description>Die besten deutschen Twitch-Clips, von der Community gewählt.</description>\n` +
      `    <language>de-DE</language>\n` +
      `    <lastBuildDate>${new Date(lastBuild).toUTCString()}</lastBuildDate>\n` +
      `    <atom:link href="${SITE}/streamclips/rss.xml" rel="self" type="application/rss+xml" />\n` +
      `${itemsXml}\n` +
      `  </channel>\n` +
      `</rss>\n`;

    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(xml);
  } catch (err) {
    return next(err);
  }
};

const feed = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Anonyme Sicht — der RSS-Reader hat keinen Login. Wir filtern danach
    // strikt auf `visibility = public`; `authenticated`/`group`-Posts
    // gehören nicht in einen öffentlich abrufbaren Feed.
    const posts = await blogService.listPosts({ viewerId: null, limit: 50 });

    const itemsXml = posts
      .filter((p) => p.visibility === 'public' && p.publishedAt !== null)
      .slice(0, 20)
      .map((p) => {
        const link = `${SITE}/blog/${encodeURIComponent(p.slug)}`;
        const pubDate = rfc822(p.publishedAt);
        return [
          '    <item>',
          `      <title>${xmlEscape(p.title)}</title>`,
          `      <link>${link}</link>`,
          `      <guid isPermaLink="true">${link}</guid>`,
          pubDate ? `      <pubDate>${pubDate}</pubDate>` : '',
          p.excerpt
            ? `      <description>${xmlEscape(p.excerpt)}</description>`
            : '',
          '    </item>'
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n');

    const lastBuild =
      posts
        .map((p) => p.updatedAt ?? p.publishedAt)
        .filter((v): v is Date => v != null)
        .map((v) => v.getTime())
        .reduce((a, b) => Math.max(a, b), 0) || Date.now();

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
      `  <channel>\n` +
      `    <title>broiler.dev — Blog</title>\n` +
      `    <link>${SITE}/blog</link>\n` +
      `    <description>Gedanken &amp; Notizen zu Backend, Infrastruktur und Homelab von Paul Wechselberger.</description>\n` +
      `    <language>de-DE</language>\n` +
      `    <lastBuildDate>${new Date(lastBuild).toUTCString()}</lastBuildDate>\n` +
      `    <atom:link href="${SITE}/blog/rss.xml" rel="self" type="application/rss+xml" />\n` +
      `${itemsXml}\n` +
      `  </channel>\n` +
      `</rss>\n`;

    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(xml);
  } catch (err) {
    return next(err);
  }
};

export default { feed, clipFeed };
