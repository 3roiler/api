# CONCEPT — broiler.dev

This document is the **design rationale** companion to `ROADMAP.md`. The
roadmap is the canonical, ID-stable backlog (`IDEA-01` … `IDEA-33`); this
document explains, per IDEA, *what problem it solves*, *what shape the
solution takes*, *what alternatives were considered*, and *what we accept as
the cost*. It is the "destination" doc; `IMPLEMENTATION_PLAN.md` is the
"route" doc and owns concrete file paths, commands, and step-by-step work.
If you find a line of this document drifting into "edit file X, run command
Y" — it belongs in the implementation plan instead.

Like the roadmap, this file is duplicated verbatim across `3roiler/web` and
`3roiler/api`. Treat IDEA IDs as the contract: don't rename, don't reuse.
This doc is incomplete by design where the roadmap is — we present trade-offs
and mark explicit `> **Decision needed**:` lines where the maintainer needs
to resolve a fork before implementation can land cleanly.

## Skipped (closed in ROADMAP, not redesigned here)

- **IDEA-15** — `/health` already verifies DB and Redis via
  `getHealthState`. Premise refuted by the code; nothing to design.
- **IDEA-26** — Account-deletion self-service UI already exists
  (`nuke()` wired to `POST /user/nuke`). Premise refuted; closed.

---

## Quick wins (P0)

These three are cheap, low-risk cleanups. Their "concept" is mostly "remove a
trap" rather than a system design. They are documented here only so the doc
covers the full ID space.

### IDEA-01: Drop dead deps in `api`

`jsonwebtoken` and `@types/jsonwebtoken` are residual from the pre-`jose`
auth stack and are not referenced by any source file; `ts-node-dev` is a
leftover dev runner replaced by `tsx`. Keeping unused dependencies is a
silent supply-chain liability — every transitive update is a CVE we have
to evaluate for nothing. Concept: declare these dependencies dead, remove
them in a single PR, confirm the build and `tsx watch` both still work.
No design decisions, no alternatives worth listing.

### IDEA-03: Process the open Dependabot PRs

Seven Dependabot PRs sit open against `api` (express-rate-limit, jose,
eslint, @types/node, ts-eslint parser, node:26-alpine, qs). Each is small;
together they are a backlog that signals "the bot's work doesn't get
merged," which trains the team to ignore future security PRs. Concept:
merge as a bundled "dependency train," group by risk (patch versions
first, major versions last so any regression has a small bisect window),
re-run the build between groups. This is also a prerequisite to IDEA-28
(Renovate) — switching tooling mid-backlog rebuilds the same backlog.

### IDEA-04: Close the `make start-all` paper trail

`CLAUDE.md` already documents that `make start-all` was a fiction (the
target was renamed to `start`). The remaining mention is `README.md` line
85, which still uses `make start` (the correct command) — verify by `grep
-rn start-all` across both repos that nothing else refers to the old name,
then mark closed. The roadmap status is `partial` only because we haven't
done the final sweep. No design.

### IDEA-17: Soften Redis-error `process.exit(5)`

**Problem.** `services/persistence.ts` registers a single `onError` handler
that, on *any* Redis error (transient network blip, brief failover, even
the upstream `client.on('error', …)` event during reconnect), tears down
both Postgres and Redis and exits with code 5. The container restarts.
Under sustained Redis instability this becomes a restart loop, the API
goes from "degraded for revocation lookups" to "fully unavailable for
every request."

**Concept.** Redis errors fall into two classes:

1. *Transient* — connection reset, brief unavailability, retry backoff.
   These should be logged and counted, not fatal. The `redis` client
   already has built-in reconnect; we just need to stop fighting it.
2. *Persistent* — N consecutive failures over T seconds, or an explicit
   `ECONNREFUSED` after the reconnect ceiling. These genuinely indicate
   "Redis is gone, exit so the orchestrator restarts us on a healthy
   host."

The design is a small policy wrapper: on error, log structured event,
increment a counter; if the counter crosses a threshold within a sliding
window (e.g. 10 errors in 60s), then exit. Postgres errors keep their
current "abort on connection-pool error" behaviour for now — they are
rarer and the failure modes are different.

**Trade-offs.** Soft-failing on Redis means in-flight auth-revocation
checks may return stale results (a recently-revoked token might briefly
re-validate). Acceptable: revocation TTLs are short (≤24h), and a hard
shutdown was strictly worse — it dropped *all* live requests, not just
the revocation-cache ones. Decision recorded inline in
`persistence.ts`.

**Open question.** Should the wrapper expose health-state delta to
`/health` (i.e. "running but Redis is degraded → 200-with-warning, not
503")? Currently `getHealthState` returns 503 on either backend failing.
A degraded-but-serving response would mean adding a third "warn" tier;
the deployment orchestrator's behaviour on warn vs. ok needs to be checked
before designing this.

> **Decision needed**: Sliding-window threshold for "give up and exit"
> (default proposal: 10 errors / 60s). Tightening reduces stale-cache
> risk but increases restart churn; loosening does the inverse.

---

## Tech debt (P1) — the meaty section

### IDEA-02: Harmonize Node versions

**Problem.** Three different Node versions are declared across the web
repo:

- `devcontainer.json` → `typescript-node:22`
- `Dockerfile` → `node:26-alpine` (this is what ships)
- `.github/workflows/lighthouse.yaml` → `node-version: '24'`

This is not just untidy — it means a developer's local environment
(node 22) builds against a different runtime than what is deployed
(node 26), and CI's quality gate (node 24) is yet a third. Subtle
breakages — a Node 26 stdlib change, a TLS-default difference, a
`fetch` quirk — won't surface until production. The api repo doesn't
have this fan-out because its only declared version is the Dockerfile.

**Proposed design.** Pick one Node version and codify it as the source
of truth, with all three call sites referencing it. The mechanism is
free of design choice — what matters is which version. Two reasonable
poles:

- **Follow Dockerfile (Node 26).** Ships closest-to-prod. Risk: 26 is
  current-line; LTS lifecycle is shorter.
- **Pin to a recent LTS (Node 24).** Lighthouse already uses it; LTS
  gives a longer support window. Risk: a small lag behind the
  ecosystem's leading-edge features.

The roadmap recommends "24 LTS-ish or follow Dockerfile=26." Either is
defensible; the asymmetric cost is that *choosing nothing* is the bad
state.

**Trade-offs.** Devcontainer images come from Microsoft; bumping the
devcontainer to a non-existing tag fails fast. The Dockerfile is what
production runs; that's the one that *matters*. The Lighthouse CI
container is the cheapest to bump.

> **Decision needed**: Node 24 (LTS) or Node 26 (current)? Recommend
> 24 unless there is a Node 26-specific feature we depend on (a quick
> audit of `engines` and `tsconfig.target` says no).

### IDEA-05: Split `services/index.tsx` (web)

**Problem.** `web/src/services/index.tsx` is 2275 lines, 195 exports, and
the single import surface for every backend call in the SPA. Concrete
symptoms:

- Two parallel feature PRs that both touch the file collide on imports
  and type ordering (merge churn).
- Reading the file to understand a domain (e.g. comments) forces scrolling
  past unrelated domains.
- The TypeScript LSP rebuilds the whole module on every keystroke in any
  page that imports from it (which is all of them).

A scan of the export list shows the exports cluster cleanly into
domain groups:

| Cluster | Approx. count | Examples |
| --- | --- | --- |
| auth + me | ~7 | `getMe`, `updateMe`, `nuke`, `loginToGithub`, `authenticateGithub`, `logout` |
| blog | ~5 | `listBlogPosts`, `getBlogPost`, `createBlogPost`, `updateBlogPost`, `deleteBlogPost` |
| admin users + groups + permissions | ~15 | `listAdminUsers`, `grantPermission`, `addGroupMember`, … |
| app settings + secrets | ~6 | `listAppSettings`, `upsertAppSetting`, `writeAppSecret`, … |
| metrics / DigitalOcean | ~10 | `getMetricsStatus`, `getAppCpu`, `getDatabaseDisk`, … |
| printers + gcode + stl + print-requests + print-jobs | ~30 | `listPrinters`, `createPrinter`, `listGcodeFiles`, `createPrintRequest`, `listPrintJobs`, … |
| streamclips (clips, awards, sections, contributors, reports, leaderboard, browse) | ~25 | `submitClip`, `getNextClip`, `rateClip`, `getLeaderboard`, `adminListClips`, … |
| comments + comment-mutes | ~10 | `listClipComments`, `postBlogComment`, `moderateDeleteComment`, … |
| moderation + foryou settings | ~4 | `getModerationSettings`, `updateModerationSettings`, … |

**Proposed design.** Move to a directory `services/` with one file per
domain. Re-export everything from a barrel `services/index.ts` so
existing import sites (`from "../services"`) keep working unchanged.
Shared primitives (`ApiError`, the configured axios client, `toApiError`,
the CSRF retry interceptor) live in `services/_client.ts`. Types stay
co-located with the functions that use them.

The shape (sketch, not interfaces) is:

```
services/
  _client.ts          // shared axios instance + ApiError + interceptor
  index.ts            // barrel re-export
  auth.ts             // getMe, login*, logout, nuke
  blog.ts
  admin-users.ts      // listAdminUsers, grantPermission, …
  admin-groups.ts
  app-settings.ts
  metrics.ts
  printers.ts
  print-jobs.ts
  print-requests.ts
  clips.ts
  comments.ts
  moderation.ts
```

**Alternatives considered.**

- *Leave it as one file, just better organised with section markers.*
  Rejected: doesn't solve the merge-collision or LSP-rebuild problem.
- *Move to a domain-driven layout (`features/clips/services.ts`,
  `features/blog/services.ts`).* Rejected: the SPA is small enough
  that a flat services dir is easier to scan than a deep feature
  layout, and this matches the api's `src/services/` convention.

**Trade-offs / risks.**

- The barrel `services/index.ts` is the *one* allowed barrel in the
  codebase (CLAUDE.md). Keeping the import contract (`from
  "../services"`) means consumers don't change. Risk: barrels can hide
  circular imports — `_client.ts` MUST NOT import any domain module.
- Shared types between modules (e.g. `User` referenced by both `auth.ts`
  and `admin-users.ts`) will need a home. Proposal: keep cross-cutting
  types in `services/_types.ts`; resist the urge to make a global
  `models/` dir, that's a bigger refactor.

**Open question.** Whether to split `streamclips` further (clips vs.
awards vs. sections vs. contributors) or keep one `clips.ts`. The
current ~25 exports fit one file fine; splitting now creates more
files to navigate. Default: keep them together; split later if the
module crosses ~500 lines.

### IDEA-06: Split `pages/DashboardSettings.tsx`

**Problem.** 1257 lines, 12 top-level components in one file. Reading
the file means scrolling past 11 unrelated components to get to the one
you want. The structure inside is already clean — there are exactly two
`<section>` blocks at the top level (DigitalOcean + Erweitert), and each
section has its own row/list/create child components. The file is *also*
the blocker for IDEA-21 (mobile-responsive pass) — the roadmap call-out
is correct, refactoring this for a 360 px width while the file is a
monolith means two big diffs touching the same component boundaries.

**Proposed design.** Co-locate per-section subcomponents under a
folder. The page export stays at `pages/DashboardSettings.tsx`, but
its body now imports thin section components:

```
pages/
  DashboardSettings.tsx          // page wrapper + DashboardLayout + section composition
  dashboard-settings/
    DigitalOceanSection.tsx      // header + AppsEditor + curated rows
    AdvancedSection.tsx          // raw key/value lists + create forms
    rows/
      CuratedSettingRow.tsx
      CuratedSecretRow.tsx
      AdvancedSettingRow.tsx
      AdvancedSecretRow.tsx
    forms/
      AdvancedSettingCreate.tsx
      AdvancedSecretCreate.tsx
```

Shared types (`CuratedSetting`, `SectionProps`) live in a co-located
`types.ts` to keep imports short. The `CURATED_DO_SETTINGS` /
`CURATED_DO_SECRETS` arrays are configuration data, not components —
they go in `dashboard-settings/curated.ts`.

**Alternatives considered.**

- *Move everything to a flat `components/settings/` dir.* Rejected:
  these components are not shared with any other page; co-location
  keeps the blast radius of a settings change inside one directory.
- *Use a tab/panel abstraction (one Tabs component, two TabPanels).*
  Rejected: the two sections are currently stacked vertically, not
  tabbed, and changing the visual model is out of scope for this
  refactor. IDEA-21 may revisit this.

**Trade-offs / risks.**

- New file count goes up. Acceptable: each new file is short and
  single-purpose; navigation by filename is faster than ctrl-F in a
  1257-line file.
- Prop-drilling: the section components currently receive
  `{ settings, secrets, onReload, onError, onInfo }`. Splitting
  preserves this — no context provider needed.

**Open question.** Whether the `flashInfo` / `setError` toast plumbing
should be lifted to a tiny `useFlash` hook now, while we're moving
things, or left as prop-drill. The hook is two lines and would also
serve IDEA-19 (skeletons / loading UX). Defer the hook to IDEA-19.

### IDEA-07: Add a test runner (both)

**Problem.** Zero tests in either repo. Some logic is genuinely tricky and
deserves coverage:

- `api/src/services/comment.ts` uses `pg_advisory_xact_lock` to make the
  30-second cooldown check atomic. Reviewer feedback #5 closed a
  double-submit race; nothing prevents a future change from re-opening it.
- `api/src/services/user.ts` `anonymizeUser` is a 7-DELETE + 1-UPDATE
  transaction; the invariant "all-or-nothing" is asserted only by the
  `withTx` wrapper.
- Permission seeding in `services/bootstrap.ts` has two code paths
  (boot-time + per-login) and a subtle "admin user does not exist yet"
  branch.

On the web side, the lower bar is "smoke tests" — `safeHttpUrl`,
`asset-helpers` formatters, the CSRF retry interceptor, route-table
sanity (no duplicate paths) — small unit tests that catch real
regressions without ceremony.

**Proposed design.**

- **api**: Vitest (or `node:test`). Postgres + Redis come from
  `docker-compose` / a throwaway test database. Tests are split into
  *unit* (pure functions: column constants, SQL builders) and
  *integration* (the comment cooldown lock, the anonymise transaction,
  the bootstrap idempotency). Integration tests reuse the existing
  compose stack via a `MAKE_TARGET=test-up` shortcut.
- **web**: Vitest + `@testing-library/react` for the few components
  that have logic worth testing. `jsdom` env. Snapshot tests are
  banned (they rot); explicit assertions only.

We start with three to five tests per repo as a *harness* — enough to
prove the toolchain works, with one clearly meaningful test (comment
cooldown for api, CSRF retry for web). Coverage is *not* a goal yet.

**Alternatives considered.**

- *`node:test` for api instead of Vitest.* Built-in, zero deps,
  perfectly fine for the API. Vitest has nicer watch UX, better diffs,
  and matches web. Pick *one* runner for the org to reduce mental
  overhead.
- *Playwright for end-to-end first.* Higher value per test but much
  higher infrastructure cost (browser, fixtures, the SPA + API +
  Postgres + Redis all up). Defer: unit + integration first, e2e when
  the harness is proven.

**Trade-offs.**

- A test DB schema needs migrations to run against it on every CI
  invocation. `make migrate-up` against a throwaway Postgres adds
  ~5–10 s per CI run. Acceptable.
- Mocking Redis vs. running real Redis: lean toward real Redis (cheap,
  matches prod behaviour); avoid `ioredis-mock` style fakes — they
  drift from real behaviour and produce false confidence.

> **Decision needed**: Vitest vs. `node:test` for api. Vitest is the
> consistent answer with web; `node:test` is the minimalist answer
> with no new dep. Recommend Vitest for consistency.

### IDEA-08: ESLint + Prettier for web

**Problem.** `web` has no lint script, no format script, and no
`eslint.config.*` file. Style drifts between contributors and AI agents.
The api repo has a flat-config ESLint already
(`@typescript-eslint/recommended`, `no-console: 'off'`, `argsIgnorePattern:
'^_'`); the gap is asymmetric.

**Proposed design.** Mirror the api's flat config where applicable:

- `@typescript-eslint/recommended` as the base.
- `argsIgnorePattern: '^_'` (consistent with api).
- React-specific rules: `eslint-plugin-react` + `eslint-plugin-react-hooks`
  (rules-of-hooks, exhaustive-deps).
- `no-console`: keep ON for web (unlike api where it's intentionally
  off until IDEA-12 lands). The SPA shouldn't ship `console.log` to
  end users' browsers.
- Prettier for formatting only; rules-that-conflict are off (the
  `eslint-config-prettier` integration).

`npm run lint` + `npm run lint:fix` + `npm run format` scripts mirror
the api's surface.

**Alternatives considered.**

- *Biome instead of ESLint+Prettier.* Faster, single binary. Rejected
  for now: api is already on ESLint, and we want consistency more than
  we want speed (lint runtime is not a measured pain point).
- *Stricter rules from day one (no-unused-vars: error, no-unsafe-*).*
  Rejected: lands as a wall of red on first run; better to ratchet up
  rules after the codebase passes the baseline.

**Trade-offs.** A first run will surface dozens of warnings; the PR
needs a "fix-as-you-go" pass before merge. Risk of disrupting feature
PRs in flight — sequence this BEFORE the IDEA-05/06 splits, so the
big refactors are formatted consistently.

**Open question.** Tailwind class-order plugin
(`prettier-plugin-tailwindcss`) sorts utility classes deterministically.
Useful for diff hygiene; the cost is one more plugin and an opinion
about class order. Recommend yes — Tailwind v4 + JIT already cares
about order in edge cases.

### IDEA-12: Observability (both)

**Problem.** 23 `console.*` call sites in `api/src` (counted, matches
roadmap). They are unstructured (free-text + interpolated values), not
indexed, not searchable, not aggregable. Examples:

- `system.ts:316` — `console.error('ERROR 💥:', err)` — every unhandled
  exception. We don't know how often or which class of error.
- `metrics.ts:175–217` — five different `console.error` paths around the
  DO metrics fetch (timeout, transport failure, 401, 404, generic).
  Worth aggregating per-status to see if the token is rotating.
- `services/logger.ts:18` — request-log middleware, one line per
  request, no structure.
- `persistence.ts:10` — fires before the process exits; right now it's
  the *only* signal we have that Redis fell over.

The web side has scattered `console.error` in catch blocks (e.g.
`DashboardSettings.tsx:134`). Less critical, but for user-facing
errors we currently have no way to see them at all.

**Proposed design.** Two layers, separable:

1. **Structured logger (pino).** Replace `services/logger.ts` and the
   23 `console.*` call sites with a `pino` logger imported once and
   used everywhere. Log lines are JSON; severity is a real level, not
   a function name. Output stays stdout (Docker / DO captures it).
   This is mechanical work, but a *consistent* mechanical pass —
   resist the urge to over-design log fields.
2. **Error tracker (Sentry or self-hosted GlitchTip).** Hook unhandled
   errors and `AppError.internal()` (the 500-class) into an error
   tracker. Web side: hook into the React error boundary and the
   `axios` interceptor. Tracker captures stack, request context, user
   id (when available, never PII), release version.

These can land separately. Pino first (smaller blast radius, no new
infra), tracker second (real infra decision, see below).

**Alternatives considered.**

- *Just structured logs, no tracker.* Doable; the log aggregator (e.g.
  DigitalOcean Logs, Logtail) can do alerting. Trade-off: no
  release-tracking, no per-issue grouping, no source-map upload.
- *OpenTelemetry from the start.* Right answer for distributed
  systems; overkill here (one API service, one SPA, no microservice
  fan-out). Defer.

**Trade-offs / risks.**

- Pino's JSON output is harder to skim in `make logs`. Add `pino-pretty`
  as a dev-only formatter; production stays JSON.
- Sentry SDK pulls in ~50–80 kB on the web side. Acceptable; the
  `<Seo>` + AdSense already dominate the third-party budget.

> **Decision needed**: Sentry (SaaS, generous free tier, friction-free
> setup) vs. GlitchTip (self-hosted, Sentry-protocol-compatible, costs
> server time + ops). The roadmap is intentionally non-prescriptive.
> Recommend Sentry for the free tier unless the maintainer wants the
> self-hosted-data-sovereignty story.

> **Decision needed**: Replace `console.*` in one PR (23 sites) or
> per-module (5 PRs at ~5 sites each). Roadmap raises this; recommend
> one PR — the change is shallow per site, and reviewing five
> identical PRs is worse than reviewing one.

### IDEA-24: Generalise admin audit log

**Problem.** Migration `_039_comment_restore_audit` added three columns
to the `comment` table (`restored_at`, `restored_by_user_id`,
`last_deletion_reason`) to capture *one* moderator action:
"comment was restored." The migration's commit message even says "vorher
ging die Mod-Aktion verloren." That pattern (add columns per action) is
a footgun: the next moderator action — permission grant, print-job
rejection, user anonymisation, clip status change — will either grow
its own per-table columns or be silently lost.

A scan of the codebase shows at least these admin actions that *should*
have an audit trail and currently don't:

- Permission grants/revokes (`grantPermission`, `revokePermission`,
  `grantGroupPermission`, `revokeGroupPermission`).
- Group membership changes (`addGroupMember`, `removeGroupMember`).
- Clip moderation (`adminSetClipStatus`, `adminBulkModerateClips`).
- Print-request status changes (approve / reject).
- User anonymisation (currently has a `console.info` log line, no DB
  record).

**Proposed design.** Introduce a single polymorphic `audit_log` table
with the shape (rough):

| Column | Notes |
| --- | --- |
| `id` | uuid pk |
| `actor_user_id` | uuid, FK to `user`, nullable (system actions) |
| `action` | enum/text, e.g. `comment.restore`, `permission.grant` |
| `target_type` | enum/text, e.g. `comment`, `user`, `clip` |
| `target_id` | uuid (not FK — target may be soft-deleted/anonymised) |
| `reason` | text, nullable |
| `metadata` | jsonb, action-specific (old value, new value, …) |
| `created_at` | timestamptz default now() |

Indexed on `(actor_user_id, created_at desc)` and `(target_type,
target_id, created_at desc)` so both "what did this admin do?" and
"what happened to this clip?" are cheap.

The three columns added in migration `_039` are kept for now — they're
the canonical example of *the wrong shape*, but ripping them out is a
separate migration and the column data is real audit data we don't
want to lose. Migration adds the new table; a follow-up backfill copies
existing `comment.restored_*` rows into `audit_log`.

**Alternatives considered.**

- *Per-resource audit table* (`comment_audit`, `permission_audit`,
  `clip_audit`). Pro: tight schema per action, foreign keys actually
  work. Con: schema sprawl, every new audited action means a new
  migration; queries like "show me everything actor X did this week"
  become a five-way UNION. Rejected.
- *Stream to an external audit system* (e.g. an append-only S3 bucket).
  Pro: tamper-evident, decoupled from Postgres. Con: operational
  complexity, query story is bad. Defer; the polymorphic table can
  later be teed to such a sink.
- *jsonb-only table (no `action` / `target_type` columns, all in
  metadata)*. Pro: maximum flexibility. Con: indexing and query shape
  are bad; type-safety in the TS layer is bad. Rejected; the
  `action` + `target_type` columns are worth their weight.

**Trade-offs / risks.**

- Polymorphic FK to `target_id` means we can't enforce referential
  integrity. Acceptable: audit rows must survive target deletion
  (especially for `user` rows after anonymisation).
- The `metadata` jsonb makes ad-hoc additions easy *and* easy to
  abuse. Convention: each action has a documented schema in
  `src/services/audit.ts` (in code, not in DB). Drift will happen;
  accept it.

> **Decision needed**: Backfill `comment.restored_*` into `audit_log`
> and drop the three columns, or keep them as denormalised cache?
> Recommend backfill + drop in a follow-up PR — having one source of
> truth for audit is the whole point of this IDEA.

> **Decision needed**: Should the audit table be readable through the
> existing dashboard (a new `dashboard.audit` permission and page),
> or admin-DB-only for now? Recommend a tiny read-only dashboard page
> as part of the same PR — invisible audit data tends to stay invisible.

---

## P2 — backlog with intent

### IDEA-09: Streamclips discovery (partial)

Server-side scaffolding is there: `twitch_category` and `award_category`
tables exist (migration `_035`). What's missing is the user-facing UI to
browse by category and a "follow contributor" loop. The roadmap calls
out the fork explicitly:

- **(a)** Tag/category browse — cheap on top of existing tables, mostly
  a new page + a `browseClips` endpoint (which already exists in
  `services/index.tsx`!). Ship first.
- **(b)** Contributor-follow + personal feed — greenfield: new table
  `contributor_follow`, follow/unfollow endpoints, a `/streamclips/me/feed`
  query. Bigger surface.

**Design call.** Land (a) before (b); they share zero schema and (a) is
a small page, (b) is a small feature. The roadmap's open question about
splitting into IDEA-09a / IDEA-09b is recorded; we proceed without
splitting the ID to preserve numbering.

### IDEA-10: Scheduled publishing + private draft preview

Today `services/blog.ts` has a binary `publish?: boolean`. Two additions:

1. `publishAt timestamptz` on `blog_post`; the visibility query treats
   `published_at IS NOT NULL AND published_at <= NOW()` as published.
   A small cron-or-on-read check materialises new "live" posts.
2. Signed preview tokens for drafts: HMAC-signed short-lived token
   carrying `{post_id, expires_at}`, accepted by `getBlogPost` as a
   bypass for the visibility filter. Token never grants write access.

Design call: prefer "on-read evaluation" over a cron job. Postgres
already evaluates the timestamp on every list query; adding a cron is
infrastructure we don't need.

### IDEA-13: Image pipeline for streamclip thumbnails

Today the clip thumbnail URL is Twitch's CDN URL passed through.
Pro: zero storage, always fresh. Con: third-party CDN, no `srcset`, no
modern formats (WebP/AVIF), no lazy-load metadata. The pipeline
sketches as: fetch original → encode WebP + AVIF + sizes (e.g. 320 / 640
/ 1280) → store somewhere → serve our URLs. The "store somewhere" is
the real decision — DO Spaces, R2, or a Postgres `bytea` cache for
small thumbs. Probably DO Spaces, matches existing infra.

### IDEA-14: HTTP/3 + cache headers (partial)

Cache headers are already set in `Caddyfile` (the `@assets` matcher
already sets `Cache-Control: public, max-age=31536000, immutable`).
HTTP/3 is implicit in current Caddy (QUIC enabled by default when TLS
is). The remaining work is a *one-pass verification*: confirm with
`curl --http3` against prod and inspect `Alt-Svc` headers. May be
closable without code change.

### IDEA-16: Postgres backup beyond DigitalOcean snapshots

`pgbackrest` or WAL-G for point-in-time recovery. Belongs in the infra
repo (not application code), so this CONCEPT entry exists only so the
ID isn't orphaned. The design call is "managed-WAL service vs.
self-hosted backup destination"; defer to infra repo discussion.

### IDEA-19: Loading skeletons in dashboard lists

Spinners give no shape information; skeletons preserve layout and
reduce perceived latency. Design: introduce one `<Skeleton>` primitive
(rectangle with shimmer animation, respects `prefers-reduced-motion`)
and replace dashboard list spinners. Don't go global yet — start with
the dashboard list pages where the layout shift is most visible.

### IDEA-20: axe-core in Lighthouse CI

Lighthouse already covers a11y at threshold 0.9; axe-core gives deeper
rule coverage (more WCAG sub-rules, better element-level reporting).
Cheap to wire: add the `@lhci/cli`-compatible axe assertion or run
axe as a separate job. Both work. Pick the path that runs in the same
workflow file as Lighthouse so failures land in one place.

### IDEA-21: Mobile-dashboard polish

Depends on IDEA-06. The current `DashboardSettings.tsx` is too big to
do a 360 px responsive pass in one PR. After IDEA-06 splits the page,
each section component can be made responsive independently and
reviewed independently. No design call beyond "split first."

### IDEA-23: 2FA for admin accounts via TOTP

**Problem.** Admin accounts have admin-class permissions
(`admin.manage`, `dashboard.*`). Today they authenticate with the same
flow as any user (local login or OAuth). A leaked admin cookie is a
full takeover. We want a second factor on admin-class accounts.

**Proposed design.** TOTP (RFC 6238) via `otpauth`. New table
`user_totp_secret` holding `{user_id, secret_encrypted, created_at,
last_used_at}`. Flow:

1. *Enrollment* — admin opens `/dashboard/security`, server generates
   secret, returns provisioning URI + QR; admin scans, submits a
   confirmation TOTP, server stores the encrypted secret.
2. *Login* — after primary auth succeeds, if the user has a TOTP
   secret AND has any admin-class permission, JWT is issued with a
   `factor: 'primary'` claim only. Routes gated by
   `requirePermission('admin.*')` additionally check `factor ===
   'mfa'`. A separate `/login/mfa` endpoint accepts the TOTP and
   re-issues a JWT with `factor: 'mfa'`.
3. *Recovery* — 10 single-use recovery codes shown once at enrollment,
   stored hashed. Optional in v1; nice-to-have in v2.

**Alternatives considered.** WebAuthn / passkeys — modern, more secure,
much more code. Defer; TOTP is the 80/20.

**Trade-offs.** TOTP secret encryption reuses the existing AES-256-GCM
keyset (the same one `app_secret` uses — see IDEA-24's audit-table
section on key sharing). MFA for admins only, not all users — keeps
the scope tight; can be extended later.

### IDEA-25: CSP `report-to` endpoint

Today the `Caddyfile` has a strict CSP but no reporting. Concept: add a
tiny `/csp-report` controller on the api (accepts `application/csp-report`
+ `application/reports+json`), validates loosely (the spec is messy),
logs structured. Caddy gets a `report-to` group directive pointing at
the api endpoint.

The design call is *what to do with reports*. Two paths:

- **Log-only** (cheap; reports show up in the structured logs once
  IDEA-12 lands). Recommended for v1.
- **Persist in a `csp_violation` table** with deduplication. Useful if
  the CSP is iterated and we want diff stats over time. Defer.

> **Decision needed**: Log-only or persist? Recommend log-only — most
> CSP reports in the wild are extension noise; persisting builds a
> noise database.

### IDEA-27: Pre-commit hooks via husky + lint-staged

Depends on IDEA-08 (web has no ESLint to run). After IDEA-08 lands,
add `husky` + `lint-staged` to both repos: ESLint on changed files,
Prettier on changed files, no test runs (too slow; CI handles tests).
Both repos pick up the same `.husky/pre-commit` shape — keep tooling
parallel.

### IDEA-29: PR + Issue templates

Add `.github/PULL_REQUEST_TEMPLATE.md` and `.github/ISSUE_TEMPLATE/` to
both repos. Low effort, helps external contributors and (more
practically here) keeps AI agents on-rails by prompting "what
changed / why / how was it tested." The template should reference
ROADMAP.md IDs ("Resolves IDEA-NN").

### IDEA-30: OpenAPI spec

17 route files. Hand-writing an `openapi.yaml` across all of them is
busywork and will rot the moment a route changes. Better: derive from
zod schemas. The dependency chain is:

1. Add `zod` for request validation (replaces ad-hoc `assertUuid` /
   manual checks in controllers).
2. Define request + response schemas next to each route.
3. Use `@asteasolutions/zod-to-openapi` or `zod-to-openapi` to generate
   the spec at build-time.
4. Serve `/openapi.json` from a controller (cheap), point Swagger-UI
   or Stoplight at it for human consumption.

This is two PRs minimum (zod adoption, then OpenAPI generation).

> **Decision needed**: Hand-written `openapi.yaml` (fast first PR,
> long-term drift) vs. zod-derived (slower first PR, sustainable).
> Recommend zod-derived — the API has growth ahead, and a
> non-machine-derived spec lies within months.

### IDEA-31: RSS feed for streamclips

Mirror `controllers/rss.ts` (the blog feed) for clips. The roadmap
already notes the gotcha: the new `/streamclips/rss.xml` route must
register BEFORE `router.use('/clips', clips)` for the same reason
`/blog/rss.xml` registers before `router.use('/blog', blog)`. No
design choice beyond "shape mirrors the blog feed."

### IDEA-32: Postgres FTS across blog + streamclips

No `tsvector` columns today. Concept: per-resource
`search_vector tsvector GENERATED ALWAYS AS (...) STORED` + GIN index,
exposing `/search?q=`. Generated columns mean we don't have to maintain
the vector by hand on update. Ranking via `ts_rank_cd`. The roadmap
correctly flags that IDEA-13 (alt-text) and IDEA-09 (category metadata)
feed this vector — doing FTS first means redoing the vector later, so
sequence after those if possible.

---

## P3 — light touch

### IDEA-11: Web Push when a print finishes

VAPID keys + service worker + opt-in UI + a server-side push dispatch
when a print transitions to `complete`. Narrow audience (printer
owners) and meaningful infrastructure. Defer.

### IDEA-18: Light-theme toggle

Tailwind v4 handles `@media (prefers-color-scheme)` cheaply; the
expensive part is auditing every page for legible light styles. Site
is dark-only by design. Concept defer to whenever a user actually asks.

### IDEA-22: Emoji reactions on comments

Comment model has no reactions today; clips have a separate rating
system. New table `comment_reaction (comment_id, user_id, emoji)`,
unique on the triple. API + UI. Medium effort, soft value. Defer.

### IDEA-28: Renovate instead of Dependabot

Renovate's grouping consolidates the kind of 7-PR backlog that
triggered IDEA-03. Concept: switch after IDEA-03 is cleared, configure
weekly grouping (patch updates auto-merged, minor grouped, major
single-PR per dep). Risk: Renovate is more configurable, which means
more rope to misconfigure. Mitigation: start with the published
"recommended" preset, only customise after we see the first month's
PR cadence.

> **Decision needed**: Auto-merge tier — recommend "patch only" for
> the first month, expand to minor after we see the failure rate.

### IDEA-33: Newsletter signup

Self-hosted Listmonk or similar. External system, ongoing operational
cost (SMTP deliverability, bounce handling, GDPR). Defer until the
blog audience justifies it.

---

## Notes for the implementation-plan agent

This CONCEPT is the "what and why." The implementation plan owns:

- file paths to create / modify / delete
- npm install commands
- migration filenames and SQL
- step ordering inside a PR
- estimated hours per IDEA
- the "first PR / second PR" decomposition where this doc says "two PRs"

If something appears in BOTH docs and they disagree, the canonical answer
is: ROADMAP.md > CONCEPT.md > IMPLEMENTATION_PLAN.md. The roadmap is the
contract; this doc is the rationale; the plan is the route.
