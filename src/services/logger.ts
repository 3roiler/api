import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import config from './config.js';

/**
 * Structured logger via pino.
 *
 * Zwei Exports:
 * - `default` (Express-Middleware): ersetzt den alten `console.log`-
 *   basierten Request-Logger. Loggt eine Zeile pro Request mit
 *   method/url/status/duration/agent/ip plus einer Request-ID, die
 *   einzelne Service-Logs derselben Anfrage korreliert.
 * - `log` (Logger-Instanz): für service-/controller-Code anstelle
 *   von `console.log/info/warn/error`. JSON-Output in Prod, pretty
 *   Output in Dev (siehe `transport` unten).
 *
 * Sentry-Integration: Sentry hat eigene Breadcrumbs + captureException;
 * pino-logs gehen NICHT automatisch dorthin. Errors müssen explizit
 * mit `Sentry.captureException` gemeldet werden (siehe
 * `system.errorHandler` in IDEA-12 sentry-api).
 *
 * Konfiguration:
 * - `LOG_LEVEL` (env): trace|debug|info|warn|error|fatal. Default `info`
 *   in Prod, `debug` in Dev.
 * - `LOG_PRETTY` (env, dev only): wenn nicht-`false`, formatieren wir
 *   die Output-Zeile menschenlesbar via `pino-pretty`. Prod kriegt
 *   immer JSON (greift bei der DigitalOcean-Logaggregation).
 *
 * `redact` enthält Felder, die NIE im Log landen sollen — derzeit nur
 * `*.password` und Auth-Cookies. Erweitern, wenn neue PII-Sources
 * dazukommen.
 */

const isPretty = !config.isProduction && process.env.LOG_PRETTY !== 'false';
const level = process.env.LOG_LEVEL || (config.isProduction ? 'info' : 'debug');

export const log = pino({
  level,
  base: {
    env: config.isProduction ? 'production' : 'development',
    service: 'api'
  },
  redact: {
    paths: [
      '*.password',
      '*.passwordHash',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]'
    ],
    censor: '[redacted]'
  },
  transport: isPretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service,env'
        }
      }
    : undefined
});

/**
 * Express-Middleware: Request-Logger mit pino-http.
 *
 * `genReqId` erzeugt für jede Anfrage eine UUID; das Backend kann sie
 * via `req.id` an Sub-Logs hängen ("correlation ID"). `customLogLevel`
 * mappt HTTP-Status auf Pino-Level: 5xx → error, 4xx → warn, sonst info.
 * `res.locals.skipLogging = true` deaktiviert das Loggen pro Anfrage
 * (z. B. Health-Check, der sonst jeden Probe-Hit floodet).
 */
const httpLogger = pinoHttp({
  logger: log,
  genReqId: (req) => {
    // Externer Request-ID Header durchreichen, falls vom Edge-Proxy
    // gesetzt — DO Load-Balancer setzt z. B. `do-connecting-ip` aber
    // keinen Request-ID-Header standardmäßig. Eigenen Header
    // akzeptieren wir trotzdem (interne Debug-Workflows).
    const existing = req.headers['x-request-id'];
    return typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // `res.locals` wird vom Pino-HTTP-Hook NICHT gelesen — wir prüfen
  // selbst und überschreiben das Level auf `silent` für gemutete Pfade.
  // Cast: pino-http typt `res` als `http.ServerResponse`; in unserer
  // Express-App ist es immer das angereicherte `express.Response` mit
  // `res.locals`.
  customSuccessObject: (_req, res, val) => {
    const expressRes = res as unknown as { locals?: { skipLogging?: boolean } };
    if (expressRes.locals?.skipLogging) return undefined;
    return val;
  },
  serializers: {
    // Schlankere Request-Repräsentation — kein Body, kein Pfad-Parsing.
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        ip: req.ip
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    }
  }
});

export default httpLogger;
