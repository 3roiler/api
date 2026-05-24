import express, { Application, Request, Response, NextFunction } from 'express';
import limiter from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { config, logger, system, error, bootstrap } from './services';
import routes from './routes';
import cors from 'cors';
import csrfGuard from './middleware/csrf.js';

const app: Application = express();

app.set('trust proxy', 1);
app.use(cookieParser());
// Body-Limits: JSON-Endpoints transportieren nur kleine Payloads (Login,
// Settings, Kommentare). 64 KiB ist großzügig genug und macht trivialen
// Memory-Pressure-DoS unattraktiv. Große Uploads (G-Code, STL) gehen
// über eigene `express.raw()`-Routen mit eigenen Limits.
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));
// CORS mit Cookie-Auth (credentials) verträgt KEIN Wildcard '*' und kein
// bedingungsloses Origin-Reflektieren (`origin: true`) — beides ist mit
// credentials unsicher und wird von CodeQL (js/cors-permissive-configuration)
// markiert. Stattdessen validiert eine Funktion gegen eine Whitelist:
//   - CORS_ORIGIN gesetzt: kommagetrennte Whitelist (Prod: https://broiler.dev).
//   - sonst im Dev: nur lokale localhost/LAN-Origins (Vite-Dev-Server,
//     --host Netzwerk-IP) — gerade so weit offen wie nötig.
//   - sonst in Prod: kein Cross-Origin (sicher; bitte CORS_ORIGIN setzen).
const corsWhitelist =
  config.corsOrigin && config.corsOrigin !== '*'
    ? config.corsOrigin.split(',').map((o) => o.trim())
    : [];
const DEV_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$/;
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    // Kein Origin-Header: Same-Origin oder Nicht-Browser-Client → erlauben.
    if (!origin) return callback(null, true);
    if (corsWhitelist.includes(origin)) return callback(null, true);
    if (!config.isProduction && corsWhitelist.length === 0 && DEV_ORIGIN_RE.test(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  }
}));

/**
 * Dedicated rate limits for credential/OAuth endpoints. These hang BEFORE
 * the global limiter so the per-IP budget is enforced per scope (login
 * spam should not also DoS the rest of the app, and a bot hammering
 * `/twitch/stream/:channel` shouldn't burn the global bucket either).
 *
 * Window + max are deliberately tight — anything tighter and a noisy
 * mobile NAT exit hurts real users; anything looser and credential
 * stuffing becomes practical.
 */
const loginLimiter = limiter({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true });
const oauthLimiter = limiter({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true });
const oauthStateLimiter = limiter({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });
const twitchStreamLimiter = limiter({ windowMs: 60 * 1000, max: 30, standardHeaders: true });
// DSGVO-Export macht ~20 parallele DB-Queries — teurer Endpunkt, sollte
// nicht zum Hammer-Tool werden. 5/Stunde reicht für legitime Auskunfts-
// anfragen (Re-Export, Korrektur, Vergleich mit Backup).
const exportLimiter = limiter({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true });

/**
 * Helper: nur dann anwenden, wenn `req.path` *exakt* einem dieser Pfade
 * entspricht — `app.use(pfad, …)` matcht Präfixe, was hier ungewollt wäre
 * (`/twitch/oauth` würde sonst auch `/twitch/oauth-state` schlucken).
 */
function exactPath(paths: string[], handler: express.RequestHandler): express.RequestHandler {
  const set = new Set(paths);
  return (req, res, next) => {
    if (set.has(req.path)) return handler(req, res, next);
    return next();
  };
}

app.use(exactPath([`${config.prefix}/login`, `${config.prefix}/register`], loginLimiter));
app.use(exactPath([`${config.prefix}/user/me/export`], exportLimiter));
app.use(exactPath(
  [`${config.prefix}/twitch/oauth-state`, `${config.prefix}/github/oauth-state`],
  oauthStateLimiter
));
app.use(exactPath(
  [`${config.prefix}/twitch/oauth`, `${config.prefix}/github/oauth`],
  oauthLimiter
));
// Twitch-Stream-Endpoint hat einen Channel-Param im Pfad — daher hier
// prefix-match per `startsWith`.
app.use((req, res, next) => {
  if (req.path.startsWith(`${config.prefix}/twitch/stream/`)) {
    return twitchStreamLimiter(req, res, next);
  }
  return next();
});

/**
 * Global 100 req / 10 min per-IP limit. The metrics router owns its own,
 * more generous limiter — the live dashboard auto-refreshes across 7
 * endpoints and would otherwise chew through this bucket in ~7 min,
 * knocking everything else (profile, blog, settings) offline for the
 * same IP. `skip` keeps those two scopes independent.
 */
app.use(limiter({
  windowMs: 600000,
  max: 100,
  skip: (req) => req.path.startsWith(`${config.prefix}/admin/metrics/`)
}));

// CSRF: Double-Submit-Cookie-Validierung für mutierende, Cookie- oder
// Bearer-authentifizierte Requests. Bewusst NACH den Rate-Limitern
// platziert, damit ein Angreifer den Auth-Check nicht unlimitiert
// triggern kann (CodeQL js/missing-rate-limiting). Setzt zusätzlich das
// XSRF-TOKEN-Cookie für das SPA — nach cookieParser/CORS, vor den
// eigentlichen Routen.
app.use(csrfGuard);

app.use(logger);
app.use(config.prefix, routes);
app.use((req: Request, res: Response, next: NextFunction) => {
  next(error.notFound(`Route ${req.originalUrl} not found`));
});
app.use(system.errorHandler);

app.listen(config.port, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   Production: ${config.isProduction.toString().padEnd(23)}║
  ║   Port: ${config.port.toString().padEnd(30)}║
  ║   API Prefix: ${config.prefix.padEnd(24)}║
  ╚════════════════════════════════════════╝
  `);

  // Best-effort: seed admin permissions for configured ADMIN_EMAILS. Runs
  // async after listen(); a failure logs but does not crash the server.
  bootstrap.seedAdminPermissions().catch(err => {
    console.error('[bootstrap] seedAdminPermissions failed:', err);
  });
});

process.on('unhandledRejection', (err: Error) => {
  console.error('UNHANDLED REJECTION! 💥 Shutting down...');
  console.error(err.name, err.message);
  process.exit(1);
});

export default app;
