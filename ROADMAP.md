# ROADMAP — broiler.dev

This document is the canonical, prioritised backlog for the `broiler.dev`
system (`3roiler/web` + `3roiler/api`). It is duplicated verbatim in both
repos by design — downstream docs (`CONCEPT.md`, `IMPLEMENTATION_PLAN.md`)
reference these `IDEA-NN` IDs as stable contracts. **IDs MUST NOT be renumbered
or renamed**; if an IDEA is dropped, mark it `done`/`wontfix` in place rather
than reusing the slot. New ideas are appended with the next free number.

## Priority key

| Prio | Meaning |
| --- | --- |
| P0 | Do now. Cheap (<half-day), unblocks other work or fixes a real bug. |
| P1 | High value, sized for a focused PR. The "should do soon" tier. |
| P2 | Worthwhile but not urgent. Backlog with intent. |
| P3 | Consider/defer. Speculative or low ROI for this project at this stage. |

Status is binary signal, not analysis: `open` (not started), `partial` (some
code exists but goal unmet), `done` (already shipped — note where).

## Aufräumen / Quick wins

| ID | Scope | Prio | Status | Title — Note |
| --- | --- | --- | --- | --- |
| IDEA-01 | api | P0 | open | Drop dead deps (`jsonwebtoken`, `@types/jsonwebtoken`, `ts-node-dev`) — confirmed unused; `src/` only imports `jose`, dev script is `tsx`. |
| IDEA-02 | web | P1 | open | Harmonize Node versions — devcontainer 22, Dockerfile `node:26-alpine`, Lighthouse workflow 24. Pick one (recommend 24 LTS-ish or follow Dockerfile=26). |
| IDEA-03 | api | P0 | open | Process the 7 open Dependabot PRs (express-rate-limit, jose, eslint, @types/node, ts-eslint parser, node:26-alpine, qs). Bundle into one merge train. |
| IDEA-04 | api | P0 | partial | `make start-all` does NOT exist (Makefile only defines `start`). `CLAUDE.md` already documents this; `README.md` line 85 still says `make start`. Verify no other doc references `start-all`, then close. |

## Tech debt

| ID | Scope | Prio | Status | Title — Note |
| --- | --- | --- | --- | --- |
| IDEA-05 | web | P1 | open | Split `src/services/index.tsx` (2275 LOC) into per-domain modules under `services/`, re-export via `index.ts`. Unblocks parallel feature PRs. |
| IDEA-06 | web | P1 | open | Split `pages/DashboardSettings.tsx` (1257 LOC — note: ~44 KB was an over-estimate, real size is ~38 KB but file is still the biggest page). Co-locate per-section subcomponents. Blocker for IDEA-21. |
| IDEA-07 | both | P1 | open | Add a test runner — Vitest for web (unit + light component), Vitest or `node:test` for api (integration against Postgres + Redis container). Zero tests today in either repo; even a smoke-test harness raises the floor. |
| IDEA-08 | web | P1 | open | Add ESLint + Prettier to web. api has flat-config ESLint already; web has neither lint nor format script. Mirror the api config to keep rules consistent. |

## Features

| ID | Scope | Prio | Status | Title — Note |
| --- | --- | --- | --- | --- |
| IDEA-09 | both | P2 | partial | Streamclips discovery — `twitch_category` + `award_category` tables already exist server-side (migration `_035`), but no user-facing tag-browse UI. Pick one of: (a) tag/category browse page on top of existing tables, (b) contributor-follow + personal feed. Decide before implementing. |
| IDEA-10 | both | P2 | open | Blog: scheduled publishing + private draft preview links. Today `publish?: boolean` is binary (`services/blog.ts`); add `publishAt timestamptz` and a signed preview token. |
| IDEA-11 | both | P3 | open | Web Push notifications when a print finishes. Needs VAPID infra + service worker + opt-in UI. High effort for narrow audience (printer owners only). |
| IDEA-12 | both | P1 | open | Observability — wire up Sentry or self-hosted GlitchTip for error tracking on both web and api; replace ad-hoc `console.*` in `api/src/services/logger.ts` and call sites with a structured logger (pino). |

## Performance / Infrastructure

| ID | Scope | Prio | Status | Title — Note |
| --- | --- | --- | --- | --- |
| IDEA-13 | both | P2 | open | Image pipeline for streamclip thumbnails — today the URL is the Twitch CDN URL straight through. Add WebP/AVIF generation, `srcset`, lazy-loading. Likely needs a media-cache table + storage decision. |
| IDEA-14 | web | P2 | partial | HTTP/3 + tighten static cache headers. Caddyfile already sets long-term `Cache-Control` for hashed assets; HTTP/3 is implicit in modern Caddy but worth an explicit verification. Mostly already there. |
| IDEA-15 | api | — | done | `/health` already pings DB + Redis (see `getHealthState` in `services/system.ts` and `checkDatabase`/`checkCache`). Returns 503 on failure. **Premise was wrong — close this.** |
| IDEA-16 | api/infra | P2 | open | Postgres backup beyond DigitalOcean snapshots — `pgbackrest` or WAL-G for PITR. Belongs in infra repo, not application code. |
| IDEA-17 | api | P0 | open | Soften `services/persistence.ts` `process.exit(5)` on Redis errors. Any transient Redis hiccup currently kills the container and triggers a restart loop. Add bounded reconnect with backoff; only exit on persistent failure. |

## UX

| ID | Scope | Prio | Status | Title — Note |
| --- | --- | --- | --- | --- |
| IDEA-18 | web | P3 | open | Light-theme toggle — dark-only today. Tailwind v4 supports `@media (prefers-color-scheme)` cheaply; main cost is auditing every page for legible light styles. |
| IDEA-19 | web | P2 | open | Loading skeletons instead of spinners in dashboard lists. No `Skeleton.tsx` component exists yet. |
| IDEA-20 | web | P2 | open | Add axe-core a11y checks to the existing Lighthouse CI workflow. LHCI already covers a11y at threshold 0.9; axe gives deeper rule coverage and is cheap to wire in. |
| IDEA-21 | web | P2 | open | Mobile-dashboard polish — `DashboardSettings.tsx` at 360px. Depends on IDEA-06 split (current file is too big to refactor for responsiveness in one PR). |
| IDEA-22 | both | P3 | open | Emoji reactions on comments. Comment model has no reactions today; clips have a separate award/rating system. Schema change + API + UI; medium effort, soft value. |

## Security / DSGVO

| ID | Scope | Prio | Status | Title — Note |
| --- | --- | --- | --- | --- |
| IDEA-23 | both | P2 | open | 2FA for admin accounts via TOTP (`otpauth`). New table `user_totp_secret` + enroll/verify flow + middleware gate for admin-permission routes. |
| IDEA-24 | api | P1 | open | Generalise admin audit log — only `comment.restored_at`/`restored_by_user_id`/`last_deletion_reason` exist (migration `_039`). Extend to permission grants, print moderation, user anonymisation. Likely a dedicated `audit_log` table is cleaner than per-resource columns. |
| IDEA-25 | both | P2 | open | CSP `report-to` endpoint. Caddyfile has a strict CSP but no reporting; add a tiny `/csp-report` controller in api and `report-to` directive in Caddyfile. |
| IDEA-26 | web | — | done | Account-deletion self-service UI already exists — `nuke()` in `web/src/services/index.tsx:266` is called from `pages/Datenschutz.tsx`, which hits `POST /user/nuke` (api `userController.nukeMePlease`). **Premise was wrong — close this.** |

## Developer Experience

| ID | Scope | Prio | Status | Title — Note |
| --- | --- | --- | --- | --- |
| IDEA-27 | both | P2 | open | Pre-commit hooks via `husky` + `lint-staged`. Run ESLint on changed files; add Prettier once IDEA-08 lands. Neither repo has a `.husky/` directory. |
| IDEA-28 | both | P3 | open | Replace Dependabot with Renovate for grouped/auto-merge. Both repos use Dependabot today with a flat weekly schedule; Renovate's grouping would consolidate the 7-PR backlog from IDEA-03 into one or two PRs. |
| IDEA-29 | both | P2 | open | PR template + Issue templates in `.github/`. Neither repo has `ISSUE_TEMPLATE/` or `PULL_REQUEST_TEMPLATE.md`. Low effort, helps external contributors and AI agents alike. |
| IDEA-30 | api | P2 | open | OpenAPI spec. 17 route files, no machine-readable contract. Generate from route annotations (e.g. `zod-to-openapi` after introducing zod for request validation) rather than hand-writing. |

## Content / Reach

| ID | Scope | Prio | Status | Title — Note |
| --- | --- | --- | --- | --- |
| IDEA-31 | api | P2 | open | RSS feed for streamclips parallel to `/blog/rss.xml`. The blog feed lives in `controllers/rss.ts`; reuse the shape, point at `clipService.list({ published: true, limit: 50 })`. Also register the new route in `routes/index.ts` BEFORE `router.use('/clips', clips)` (same gotcha as the blog feed). |
| IDEA-32 | both | P2 | open | Search across blog + streamclips via Postgres FTS. No `tsvector` columns today; add per-resource `search_vector tsvector GENERATED` + GIN index, expose `/search?q=`. Benefits indirectly from IDEA-13 (image alt-text) and IDEA-09 (category metadata) being normalised. |
| IDEA-33 | both | P3 | open | Newsletter signup in blog (self-hosted, e.g. Listmonk). External system, ongoing operational cost. Defer until blog audience is bigger. |

## Cross-cutting dependencies

- **IDEA-21 depends on IDEA-06.** Splitting `DashboardSettings.tsx` must land
  before the mobile-responsive pass; otherwise the rewrite happens twice.
- **IDEA-27 depends on IDEA-08.** Pre-commit hooks have nothing to run on the
  web side until ESLint/Prettier exist.
- **IDEA-32 benefits from IDEA-09 + IDEA-13.** Category metadata and
  normalised media (alt text, captions) feed the FTS vector; not a hard
  blocker, but doing FTS first means redoing the vector later.
- **IDEA-30 benefits from a zod-validation pass first.** Hand-writing the
  spec across 17 route files is busywork; deriving from zod schemas turns
  it into a continuous artifact.
- **IDEA-12 (Sentry) lights up IDEA-17.** Once errors are tracked, the
  Redis-disconnect noise becomes visible — softening `process.exit(5)`
  is easier when you can measure how often it fires.
- **IDEA-28 should follow IDEA-03.** Don't switch tooling mid-backlog;
  clear the existing Dependabot PRs first, then migrate to Renovate with
  groups configured to prevent the same backlog rebuilding.

## Open questions (flag for human review — not part of the canonical list)

- The `award_category` and `twitch_category` tables (migration `_035`)
  already provide much of what IDEA-09 hints at server-side. The remaining
  work is mostly UI + a "follow contributor" feature. Worth deciding
  whether IDEA-09 should be split into IDEA-09a (categories UI, mostly
  done server-side) and IDEA-09b (contributor follow + personal feed,
  greenfield) — not done in this doc to preserve ID stability.
- IDEA-14 is mostly already shipped (long-term cache headers in Caddyfile,
  HTTP/3 implicit in Caddy). May be closable after a one-pass verification
  rather than a real ticket.
- Logger replacement (part of IDEA-12) touches every `console.*` call
  site (23 occurrences in `api/src`). Consider whether this is one PR or
  scoped per service module to keep diffs reviewable.
- `make run` in `api/Makefile` runs `make migrate-up` BEFORE `docker compose
  up` — so the migration container runs against a Postgres that hasn't
  finished booting on the very first invocation. Out of scope for the
  listed IDEAs but worth a one-line ticket.
