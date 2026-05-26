import * as Sentry from '@sentry/node';
import config from './config.js';

/**
 * Sentry-Initialisierung.
 *
 * **Reihenfolge ist wichtig**: dieses Modul wird in `app.ts` als ALLERERSTER
 * Import geladen — vor `express`, `pg`, `redis` usw. Sentrys Auto-
 * Instrumentation hookt sich in `require`/`import` ein, indem sie eigene
 * Loader registriert; späteres Importieren bedeutet, dass HTTP/DB-Spans
 * fehlen.
 *
 * Verhalten:
 * - Wenn `SENTRY_DSN` leer ist (= Default), passiert nichts. `init` wird
 *   nicht aufgerufen, das SDK liegt im Speicher aber inaktiv. Alle
 *   `Sentry.captureException`-Aufrufe sind dann No-Ops.
 * - Setzen der DSN in der DigitalOcean App Platform aktiviert das Tracking
 *   ohne Code-Deploy.
 *
 * DSGVO-Hinweise:
 * - `sendDefaultPii: false` (Default des SDK) — wir senden KEINE
 *   automatischen User-Identifier (IP, Cookie-Headers). Wenn Sentry den
 *   User braucht, setzen wir den `userId` explizit per `setUser`.
 * - EU-Region durch die DSN selbst (`*.ingest.de.sentry.io`). Bitte beim
 *   Anlegen des Projekts EU-Region wählen.
 * - `attachStacktrace: false` (Default) — Stacktraces kommen sowieso mit
 *   den `Error`-Objekten, brauchen kein Auto-Attach.
 */
if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.isProduction ? 'production' : 'development',
    // Performance-Tracing nur wenn explizit aktiviert (siehe config.ts).
    // Free-Tier-Budget liegt bei 10k Transactions/Monat — bei 0.1 sample-
    // rate und unserem Traffic großzügig genug, aber wir starten mit 0.
    tracesSampleRate: config.sentryTracesSampleRate,
    // Release-Tag — DigitalOcean App Platform setzt `RELEASE` per Deploy.
    // Fallback `dev` damit local-runs sich nicht mit Prod-Releases mischen.
    release: process.env.RELEASE || 'dev',
    // Auto-Instrumentation für Express + HTTP + Postgres + Redis ist
    // default-an. Hier nur explizit listen, wenn was zu disablen wäre.
    integrations: [Sentry.httpIntegration(), Sentry.expressIntegration()]
  });
  console.log('[sentry] initialised', {
    env: config.isProduction ? 'production' : 'development',
    tracesSampleRate: config.sentryTracesSampleRate
  });
}

export default Sentry;
