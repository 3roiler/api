import { Request, Response } from 'express';
import { log } from '../services/logger.js';

/**
 * CSP-Violation-Endpoint.
 *
 * Browser feuern POST auf diesen Pfad, sobald eine Content-Security-
 * Policy-Direktive verletzt wird (siehe `report-uri` / `report-to` in
 * `web/Caddyfile`). Zwei Body-Formate sind in der Wildnis verbreitet:
 *
 * - Klassisch (`Content-Type: application/csp-report`): Body ist ein
 *   Single-Object `{ "csp-report": { ... } }`.
 * - Neue Reporting-API (`Content-Type: application/reports+json`):
 *   Body ist ein Array von Reports mit `{ type, age, url, body }`.
 *
 * Wir loggen log-only — kein DB-Persistieren. CSP-Reports in der Wildnis
 * sind zu >90 % Browser-Extension-Noise (uBlock, Privacy-Badger, …),
 * die eigene Skripte einfügen und so die `script-src`-Direktive
 * verletzen. Ein eigenes Persistenz-Layer dafür wäre eine Noise-DB.
 *
 * Decision-Trail in CONCEPT.md: „Log-only or persist? Recommend
 * log-only — most CSP reports in the wild are extension noise;
 * persisting builds a noise database."
 *
 * Status 204 (no content) ist die übliche CSP-Konvention; Browser
 * verwerfen die Response sowieso.
 */

interface ClassicCspReport {
  'csp-report': {
    'document-uri'?: string;
    referrer?: string;
    'violated-directive'?: string;
    'effective-directive'?: string;
    'blocked-uri'?: string;
    'source-file'?: string;
    'line-number'?: number;
    'column-number'?: number;
    'script-sample'?: string;
    [key: string]: unknown;
  };
}

interface ReportingApiEntry {
  type?: string;
  age?: number;
  url?: string;
  user_agent?: string;
  body?: {
    documentURL?: string;
    referrer?: string;
    violatedDirective?: string;
    effectiveDirective?: string;
    blockedURL?: string;
    sourceFile?: string;
    lineNumber?: number;
    columnNumber?: number;
    sample?: string;
    disposition?: 'enforce' | 'report';
    [key: string]: unknown;
  };
}

function isClassicReport(body: unknown): body is ClassicCspReport {
  return (
    typeof body === 'object' &&
    body !== null &&
    'csp-report' in body &&
    typeof (body as Record<string, unknown>)['csp-report'] === 'object'
  );
}

function isReportingApiArray(body: unknown): body is ReportingApiEntry[] {
  return (
    Array.isArray(body) &&
    body.every((entry) => typeof entry === 'object' && entry !== null)
  );
}

const report = (req: Request, res: Response) => {
  // Beide Body-Shapes auf eine gemeinsame Log-Zeile reduzieren. Wir
  // loggen `console.warn` (statt `console.error`) — eine CSP-Violation
  // ist kein API-Fehler, sondern ein Signal von außen.
  const userAgent = req.get('user-agent') ?? '';
  const body = req.body as unknown;

  if (isClassicReport(body)) {
    const r = body['csp-report'];
    log.warn(
      {
        format: 'classic',
        directive: r['violated-directive'] ?? r['effective-directive'],
        blocked: r['blocked-uri'],
        document: r['document-uri'],
        source: r['source-file'],
        line: r['line-number'],
        userAgent
      },
      '[csp.violation]'
    );
  } else if (isReportingApiArray(body)) {
    for (const entry of body) {
      // Nur CSP-Reports — die Reporting-API liefert auch andere
      // (Deprecation, Intervention, …); die ignorieren wir hier.
      if (entry.type !== 'csp-violation') continue;
      const r = entry.body ?? {};
      log.warn(
        {
          format: 'reports-api',
          directive: r.violatedDirective ?? r.effectiveDirective,
          blocked: r.blockedURL,
          document: r.documentURL ?? entry.url,
          source: r.sourceFile,
          line: r.lineNumber,
          disposition: r.disposition,
          userAgent
        },
        '[csp.violation]'
      );
    }
  } else {
    // Unbekanntes Format — minimal loggen, damit wir's mitbekommen,
    // falls Browser Spec-Drift produzieren.
    log.warn({ userAgent }, '[csp.violation] unknown body shape');
  }

  return res.status(204).end();
};

export default { report };
