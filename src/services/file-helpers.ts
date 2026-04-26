/**
 * Shared file-handling helpers for the asset services
 * (`gcode.ts`, `stl.ts`, future slicer outputs).
 *
 * Lives outside the individual services so SonarCloud doesn't see two
 * copies of the same regex / sanitiser pair, and so a future bug fix
 * here lands everywhere at once.
 */

const FILENAME_SANITISE_RE = /[^a-zA-Z0-9._-]+/g;
const UNDERSCORE_CHAR_CODE = 0x5f; // '_'

/**
 * Strips leading and trailing `_` characters with two index walks.
 * Replaces the previous `/^_+/` + `/_+$/` regex pair: both forms are
 * anchored linear scans in practice, but SonarCloud's super-linear-
 * runtime hotspot heuristic flagged the `+` quantifier — and hand-
 * rolled boundaries are simply immune by construction. Bonus: no
 * regex engine spin-up for the sanitiser hot path.
 */
function trimUnderscores(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === UNDERSCORE_CHAR_CODE) {
    start++;
  }
  let end = value.length;
  while (end > start && value.charCodeAt(end - 1) === UNDERSCORE_CHAR_CODE) {
    end--;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

/**
 * Returns the value re-typed as `Buffer` after a runtime check, so the
 * caller can re-bind into a fresh local. The upload data ultimately
 * originates from `req.body` (Express types it as `any`); CodeQL's
 * type-confusion query needs every later `buffer.X` access to live
 * in a scope where the type was explicitly verified.
 *
 * Returning instead of using an `asserts`-typed function is
 * deliberate: CodeQL doesn't follow `asserts` annotations across
 * call boundaries, so a `const buffer = ensureBuffer(raw)` re-bind
 * is what actually clears the warning. Hot-spot call sites that
 * still trip the analyser keep an inline `Buffer.isBuffer` check
 * directly above the read.
 */
export function ensureBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError('Expected a Buffer instance.');
  }
  return value;
}

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
  // `replaceAll` instead of `replace` for the sanitise pass: signals
  // intent (we're collapsing every match, not just the first) and
  // keeps SonarCloud's "prefer replaceAll" warning quiet. Leading /
  // trailing underscore strip uses `trimUnderscores` (hand-rolled, no
  // regex) so SonarCloud's super-linear-runtime heuristic has no
  // surface to flag.
  const cleaned = trimUnderscores(bounded.replaceAll(FILENAME_SANITISE_RE, '_'));
  const cut = cleaned.slice(0, 120);
  return cut.length > 0 ? cut : fallback;
}
