import { Request, Response, NextFunction } from 'express';
import { clip as clipService, blog as blogService } from '../services/index.js';

/**
 * Dynamische sitemap.xml: statische Hub-Seiten + alle freigegebenen Clips +
 * alle veröffentlichten, öffentlichen Blog-Beiträge. Caddy liefert
 * `/sitemap.xml` von hier (reverse_proxy). So entdeckt Google auch die
 * Einzelseiten, die in einer rein statischen Sitemap fehlen würden.
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

/** ISO-Datum (YYYY-MM-DD) oder undefined bei ungültigem/leerem Wert. */
function isoDate(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function urlEntry(loc: string, lastmod?: string, changefreq?: string, priority?: string): string {
  return [
    '  <url>',
    `    <loc>${xmlEscape(loc)}</loc>`,
    lastmod ? `    <lastmod>${lastmod}</lastmod>` : '',
    changefreq ? `    <changefreq>${changefreq}</changefreq>` : '',
    priority ? `    <priority>${priority}</priority>` : '',
    '  </url>'
  ].filter(Boolean).join('\n');
}

const STATIC: { path: string; changefreq: string; priority: string }[] = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/blog', changefreq: 'weekly', priority: '0.8' },
  { path: '/streamclips', changefreq: 'daily', priority: '0.8' },
  { path: '/streamclips/leaderboard', changefreq: 'daily', priority: '0.7' },
  { path: '/impressum', changefreq: 'yearly', priority: '0.2' },
  { path: '/datenschutz', changefreq: 'yearly', priority: '0.2' }
];

const sitemap = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [clips, posts] = await Promise.all([
      clipService.listApprovedForSitemap(),
      blogService.listPosts({ viewerId: null, limit: 10000 })
    ]);

    const entries: string[] = STATIC.map((s) =>
      urlEntry(`${SITE}${s.path}`, undefined, s.changefreq, s.priority)
    );

    for (const p of posts) {
      // Nur öffentliche Beiträge — `authenticated`/`group` brauchen Login.
      if (p.visibility !== 'public') continue;
      entries.push(
        urlEntry(
          `${SITE}/blog/${encodeURIComponent(p.slug)}`,
          isoDate(p.updatedAt ?? p.publishedAt),
          'monthly',
          '0.6'
        )
      );
    }

    for (const c of clips) {
      entries.push(
        urlEntry(`${SITE}/streamclips/clip/${c.id}`, isoDate(c.updatedAt), 'weekly', '0.5')
      );
    }

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `${entries.join('\n')}\n` +
      `</urlset>\n`;

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(xml);
  } catch (err) {
    return next(err);
  }
};

export default { sitemap };
