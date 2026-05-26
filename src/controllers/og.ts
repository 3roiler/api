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

/**
 * Serialisiert ein JSON-LD-Objekt für die Einbettung in einem
 * `<script type="application/ld+json">`-Block. `<` wird escaped, damit ein
 * versehentliches "</script>" in einem String-Wert nicht aus dem Script-
 * Block ausbrechen kann. Spiegelt den `JsonLd`-Helper aus dem Frontend
 * (web/src/components/Seo.tsx).
 */
function jsonLdScript(data: object): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * ISO-8601-Duration aus Sekunden — `VideoObject.duration` erwartet
 * „PTnHnMnS". Twitch-Clips sind meist <60s, das Format greift trotzdem
 * auch für längere Werte. Negative/NaN-Werte werden auf 0 geklemmt.
 */
function isoDurationFromSeconds(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  let out = 'PT';
  if (h) out += `${h}H`;
  if (m) out += `${m}M`;
  if (s || (!h && !m)) out += `${s}S`;
  return out;
}

interface OgBodyLink {
  href: string;
  label: string;
}

interface OgData {
  title: string;
  description: string;
  url: string;
  image: string;
  type: 'website' | 'article' | 'video.other';
  /**
   * Optionales JSON-LD-Objekt (schema.org), das in den `<head>` gerendert
   * wird. Erlaubt Social-Crawler + (ab Crawler-Regex-Erweiterung) auch
   * Suchmaschinen-Bots, die kein JS ausführen, Rich-Result-Signale zu
   * empfangen — analog zum SPA-`JsonLd`-Helper.
   */
  jsonLd?: object;
  /**
   * Optionaler sichtbarer Body — wenn gesetzt, ersetzt er das default-
   * `<p><a>Title</a></p>` durch ein indexierbares h1+Description+Links-
   * Layout. Für JS-lose Suchmaschinen-Bots (Bingbot, Applebot, AI-Bots)
   * der eigentliche Hebel — sie sehen sonst nur einen Stub.
   */
  body?: {
    headline?: string;
    excerpt?: string;
    links?: OgBodyLink[];
  };
}

/**
 * Extrahiert einen Plain-Text-Auszug aus Markdown — Code-Blöcke,
 * Inline-Code, Bilder und Heading-Marker raus, Links auf ihren Text
 * reduziert. Pragmatischer Regex-Strip, keine Markdown-Spec-konforme
 * Parse — reicht für Crawler-Indexierung und Vorschauen.
 */
function markdownToPlainExcerpt(md: string | null | undefined, maxLen = 500): string {
  if (!md) return '';
  const stripped = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= maxLen) return stripped;
  // An letzter Wortgrenze vor `maxLen` schneiden, sonst sieht das Snippet
  // mitten im Wort abgeschnitten aus.
  const cut = stripped.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function renderOg(d: OgData): string {
  const title = esc(`${d.title} · broiler.dev`);
  const desc = esc(d.description);
  const url = esc(d.url);
  const image = esc(d.image);
  const ld = d.jsonLd ? `\n${jsonLdScript(d.jsonLd)}` : '';
  // Sichtbarer Body — beim Default nur ein Self-Link; bei `d.body` ein
  // semantisches h1 + Beschreibung + interne Links, damit Crawler ohne
  // JS-Ausführung indexierbare Inhalte (inkl. interner Navigation) sehen.
  let bodyHtml: string;
  if (d.body) {
    const h1 = esc(d.body.headline ?? d.title);
    const excerpt = d.body.excerpt ? `<p>${esc(d.body.excerpt)}</p>` : '';
    const links = (d.body.links ?? [])
      .map((l) => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`)
      .join('');
    const nav = links ? `<nav><ul>${links}</ul></nav>` : '';
    bodyHtml = `<article><h1>${h1}</h1><p>${desc}</p>${excerpt}<p><a href="${url}">${esc(d.title)} auf broiler.dev ansehen</a></p>${nav}</article>`;
  } else {
    bodyHtml = `<p><a href="${url}">${title}</a></p>`;
  }
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
<meta name="twitter:image" content="${image}">${ld}
</head>
<body>${bodyHtml}</body>
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
    const url = `${SITE}/streamclips/clip/${id}`;
    const image = safeImage(c.thumbnailUrl);
    // VideoObject (schema.org) — gleiche Felder wie der SPA-Pfad in
    // web/src/pages/streamclips/ClipDetail.tsx. Optionale Felder werden
    // nur ausgegeben, wenn die zugrundeliegenden Daten vorhanden sind —
    // sonst meldet Googles Rich-Results-Test Warnungen wegen Null-Werten.
    const uploadDate =
      (c.clipCreatedAt instanceof Date ? c.clipCreatedAt.toISOString() : c.clipCreatedAt) ??
      (c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt);
    const embedUrl =
      c.embedUrl ??
      `https://clips.twitch.tv/embed?clip=${encodeURIComponent(c.twitchClipId)}&parent=broiler.dev`;
    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: c.title,
      description: `Clip${c.broadcasterName ? ` von ${c.broadcasterName}` : ''}${c.categoryName ? ` aus der Twitch-Kategorie ${c.categoryName}` : ''}${c.creatorName ? ` — geclippt von ${c.creatorName}` : ''} auf Streamclips Germany.`,
      thumbnailUrl: image,
      uploadDate,
      embedUrl,
      publisher: { '@type': 'Organization', name: 'broiler.dev', url: SITE },
      inLanguage: c.language ?? 'de',
      url
    };
    if (c.videoUrl) jsonLd.contentUrl = c.videoUrl;
    if (c.durationSeconds && c.durationSeconds > 0) {
      jsonLd.duration = isoDurationFromSeconds(c.durationSeconds);
    }
    if (c.broadcasterName) {
      jsonLd.creator = { '@type': 'Person', name: c.broadcasterName };
    }
    if (c.ratingCount > 0 && c.avgScore !== null) {
      jsonLd.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: Number(c.avgScore.toFixed(2)),
        ratingCount: c.ratingCount,
        bestRating: 5,
        worstRating: 1
      };
    }
    if (c.viewCount > 0) {
      jsonLd.interactionStatistic = {
        '@type': 'InteractionCounter',
        interactionType: 'https://schema.org/WatchAction',
        userInteractionCount: c.viewCount
      };
    }
    return sendOg(res, renderOg({
      title: c.title,
      description: `Clip von ${broadcaster}${cat} — bewertet auf Streamclips Germany.`,
      url,
      image,
      type: 'video.other',
      jsonLd,
      // Sichtbarer Body: Headline + Excerpt mit Streamer/Kategorie/Creator
      // + interne Links zu den Hub-Pages (Streamclips Home, Leaderboard).
      // Hilft JS-losen Crawlern, internen Linkgraph zu folgen.
      body: {
        headline: c.title,
        excerpt: [
          c.broadcasterName ? `Twitch-Clip von ${c.broadcasterName}.` : null,
          c.categoryName ? `Kategorie: ${c.categoryName}.` : null,
          c.creatorName && c.creatorName !== c.broadcasterName
            ? `Geclippt von ${c.creatorName}.`
            : null,
          c.ratingCount > 0 && c.avgScore !== null
            ? `Community-Bewertung: ${c.avgScore.toFixed(2)}/5 aus ${c.ratingCount} Stimmen.`
            : null
        ]
          .filter(Boolean)
          .join(' '),
        links: [
          { href: `${SITE}/streamclips`, label: 'Mehr deutsche Twitch-Clips entdecken' },
          { href: `${SITE}/streamclips/leaderboard`, label: 'Top-Clips Leaderboard' },
          { href: `${SITE}/streamclips/contributors`, label: 'Top-Einreicher' }
        ]
      }
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
    // `getPostBySlug` filtert ohne weitere Optionen auf `published_at IS
    // NOT NULL`, aber `visibility` kann auch `authenticated`/`group` sein
    // — die gehören nicht in einen öffentlich gerenderten OG-Stub.
    if (p.visibility !== 'public') return next();
    const url = `${SITE}/blog/${encodeURIComponent(slug)}`;
    const description = p.excerpt ?? `Blog-Beitrag von Paul Wechselberger: ${p.title}.`;
    const publishedIso =
      p.publishedAt instanceof Date ? p.publishedAt.toISOString() : p.publishedAt;
    const updatedIso =
      p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt;
    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: p.title,
      description,
      author: { '@type': 'Person', name: 'Paul Wechselberger', url: SITE },
      publisher: { '@type': 'Organization', name: 'broiler.dev', url: SITE },
      url,
      mainEntityOfPage: url,
      inLanguage: 'de'
    };
    if (publishedIso) jsonLd.datePublished = publishedIso;
    if (updatedIso ?? publishedIso) jsonLd.dateModified = updatedIso ?? publishedIso;
    // Markdown-Auszug aus dem Post-Content — Crawler ohne JS bekommen
    // sonst nur Title + Excerpt und können den Volltext nicht indexieren.
    // 1200 Zeichen reichen, um die ersten ~3-4 Absätze zu erwischen.
    const plainExcerpt = markdownToPlainExcerpt(p.content, 1200) || description;
    return sendOg(res, renderOg({
      title: p.title,
      description,
      url,
      image: DEFAULT_IMAGE,
      type: 'article',
      jsonLd,
      body: {
        headline: p.title,
        excerpt: plainExcerpt,
        links: [
          { href: `${SITE}/blog`, label: 'Alle Blog-Beiträge' },
          { href: `${SITE}/blog/rss.xml`, label: 'RSS-Feed abonnieren' },
          { href: `${SITE}/`, label: 'Zur Startseite — Paul Wechselberger' }
        ]
      }
    }));
  } catch (err) {
    return next(err);
  }
};

export default { clip, post };
