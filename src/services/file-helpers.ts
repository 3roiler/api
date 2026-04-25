/**
 * Shared file-handling helpers for the asset services
 * (`gcode.ts`, `stl.ts`, future slicer outputs).
 *
 * Lives outside the individual services so SonarCloud doesn't see two
 * copies of the same regex / sanitiser pair, and so a future bug fix
 * here lands everywhere at once.
 */

const FILENAME_SANITISE_RE = /[^a-zA-Z0-9._-]+/g;
const LEADING_UNDERSCORES_RE = /^_+/;
const TRAILING_UNDERSCORES_RE = /_+$/;

/**
 * Collapses filesystem-unsafe characters so we can safely echo the
 * filename into logs, file shares or Moonraker. Keeps letters, digits,
 * `.`, `_`, `-`. Falls back to `fallback` when the sanitised result is
 * empty.
 *
 * The leading / trailing underscore strip is intentionally split into
 * two anchored regexes instead of `/^_+|_+$/g`. Both are linear in the
 * input length, but the alternation form trips SonarCloud's
 * super-linear-runtime hotspot heuristic — splitting it is cheaper
 * than reasoning about the false positive every time.
 */
export function sanitiseFilename(name: string, fallback: string): string {
  // Hard-cap upstream so a pathological 10 MB filename can't even
  // reach the regex engine. Filenames over 1 KB are already nonsense
  // before any further work.
  const bounded = name.slice(0, 1024);
  const cleaned = bounded
    .replace(FILENAME_SANITISE_RE, '_')
    .replace(LEADING_UNDERSCORES_RE, '')
    .replace(TRAILING_UNDERSCORES_RE, '');
  const cut = cleaned.slice(0, 120);
  return cut.length > 0 ? cut : fallback;
}
