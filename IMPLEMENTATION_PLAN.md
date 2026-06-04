# IMPLEMENTATION_PLAN — broiler.dev

This document is the **executable companion** to `ROADMAP.md` (the canonical
backlog with stable `IDEA-NN` IDs) and `CONCEPT.md` (the design rationale —
the "why"). This file is the **"how": the route, not the destination.** For
every open IDEA it lists the files to touch, the steps in execution order,
the commands to run, the verification step, and the rollback. A future
session — Claude or human — should be able to pick an IDEA, follow the
section verbatim, and ship it.

This file is duplicated verbatim in `3roiler/web` and `3roiler/api` (same
content on both sides). The `IDEA-NN` IDs from ROADMAP are the contract;
**do not renumber**.

## Legend

**Effort scale** (pad for the no-test-coverage risk multiplier — there is
zero automated coverage in either repo today, so even cosmetic changes
carry more uncertainty than the LOC suggest):

- **S** — under 4 hours, including PR review round-trip.
- **M** — half a day to two days. Most P1 sections.
- **L** — more than two days. Reserved for genuinely deep refactors.

**Scope** is `web`, `api`, or `both`. `both` means the PR set spans both
repos, usually a coordinated landing (server side first, then SPA).

**PR slice** in this codebase means: a branch with a green Docker build,
under ~600 changed LOC where possible, with a description that matches
what the diff actually does and references the `IDEA-NN`. Bigger refactors
(IDEA-05, IDEA-12) are split into named sub-PRs that each compile + start
on their own.

**Standard loop** for every section below:

1. `git checkout -b claude/idea-NN-short-slug` off the latest `main`.
2. Make changes, run the local verification command.
3. `git commit` with a message in the existing style
   (`type(scope): short summary` — see `git log --oneline` for examples).
4. `git push -u origin claude/...`.
5. Open a draft PR; flip to ready once the Docker build is green and any
   smoke test in the Verification block passes.
6. Merge with squash; delete the branch.

Unless noted, the rollback is **`git revert <merge-sha>`** — the codebase
has no migrations-on-deploy lock-in for any of these PRs except the ones
that explicitly add a migration (IDEA-10, IDEA-23, IDEA-24, IDEA-32). Those
sections name their downgrade step explicitly.

## Skipped (already done — see ROADMAP)

- **IDEA-15** — `/health` already pings DB + Redis (`api/src/services/system.ts`
  `getHealthState`). Closed.
- **IDEA-26** — Account-deletion self-service UI already exists
  (`web/src/services/index.tsx` `nuke()` called from `pages/Datenschutz.tsx`).
  Closed.

---

## IDEA-01 — Drop dead deps (`jsonwebtoken`, `@types/jsonwebtoken`, `ts-node-dev`)

- **Effort:** S
- **Scope:** api
- **PR strategy:** 1 PR.
- **Files:**
  - `/home/user/api/package.json`
  - `/home/user/api/package-lock.json` (regenerated)
- **Steps:**
  1. Confirm zero usage one last time:
     ```
     grep -rn jsonwebtoken /home/user/api/src
     grep -rn ts-node-dev /home/user/api/src /home/user/api/package.json
     ```
     Both `src/` greps must return empty. (Already verified during research:
     no imports exist; `dev` script uses `tsx watch`, not `ts-node-dev`.)
  2. Run the uninstall:
     ```
     cd /home/user/api && npm uninstall jsonwebtoken @types/jsonwebtoken ts-node-dev
     ```
  3. `npm run build` — must still succeed.
  4. `npm run lint` — must still be clean.
  5. Commit `package.json` + `package-lock.json` together.
- **Verification:**
  - `npm run build` exits 0.
  - `node -e "require('jsonwebtoken')"` exits non-zero (module is gone).
  - Container boot via `make start` still serves `/health` 200.
- **Rollback:** `npm install jsonwebtoken@9 @types/jsonwebtoken ts-node-dev`,
  commit. Trivial.

---

## IDEA-02 — Harmonize Node versions (web)

- **Effort:** S
- **Scope:** web
- **PR strategy:** 1 PR.
- **Files:**
  - `/home/user/web/Dockerfile` (currently `node:26-alpine`)
  - `/home/user/web/.devcontainer/devcontainer.json` (currently `:22`)
  - `/home/user/web/.github/workflows/lighthouse.yaml` (currently `node-version: '24'`)
  - `/home/user/web/.github/workflows/docker-build.yaml` (verify)
  - Mirror in `/home/user/api/.devcontainer/devcontainer.json` if the
    decision is to standardize across both repos (currently `:24`).
- **Steps:**
  1. **Blocked on design decision** in CONCEPT.md — once the target Node
     version is chosen (`24` LTS-track vs `26` matching api Docker base
     post-Dependabot, see IDEA-03 PR #75), the plan is to update all four
     touch points above to the same major.
  2. After the decision: replace the version literal in each file.
  3. `cd /home/user/web && docker build -t web-versioncheck .` to confirm
     the chosen tag exists on the registry and the build still passes.
  4. Re-run Lighthouse CI locally:
     `npm run build && npx lhci autorun --config=lighthouserc.json`.
- **Verification:** Docker build green; Lighthouse CI workflow on the PR
  still produces a report.
- **Rollback:** revert. No runtime data.

---

## IDEA-03 — Process the 7 open Dependabot PRs

- **Effort:** S
- **Scope:** api
- **PR strategy:** Not a single PR — a **merge train** through the 7
  existing PRs in the order below. Each merge re-bases the next.
- **Files:** none directly — these are Dependabot's PRs.
- **Open PRs in `3roiler/api`** (verified via `gh` / GitHub MCP):
  - **#62** — `qs` 6.15.1 → 6.15.2 (transitive, npm_and_yarn group). Merge first;
    smallest blast radius.
  - **#76** — `jose` 6.2.2 → 6.2.3. Used in `services/system.ts` for JWT
    signing — runtime-critical. Verify `make start` → login flow after merge.
  - **#80** — `express-rate-limit` 8.5.1 → 8.5.2. Re-test login + DSGVO
    export rate limits.
  - **#77** — `@typescript-eslint/parser` 8.58.2 → 8.59.4 (dev).
  - **#78** — `eslint` 10.2.1 → 10.4.0 (dev). Run `npm run lint` post-merge.
  - **#79** — `@types/node` 25.6.0 → 25.9.1 (dev). Run `npm run build`.
  - **#75** — `node` 24-alpine → 26-alpine (Docker base). **Coordinate
    with IDEA-02** — landing 26-alpine here forces the web/devcontainer/LHCI
    decision in IDEA-02. Hold until IDEA-02's design call is made; if web
    standardises on 26 also merge this last.
- **Steps:**
  1. For each PR in the order above:
     - Check the latest CI run on the PR is green:
       `gh pr checks <num> --repo 3roiler/api`.
     - Squash-merge: `gh pr merge <num> --repo 3roiler/api --squash --delete-branch`.
     - Pull `main` locally, smoke-test (`make start`, hit `/health`,
       smoke a login).
  2. After all merges, run `npm audit` and confirm no new high/critical
     vulnerabilities were introduced.
- **Verification:**
  - `npm run lint && npm run build` clean after each merge.
  - `curl localhost:3000/api/health` returns 200 after `make start`.
- **Rollback:** revert the offending merge commit; Dependabot will reopen
  the PR on its next schedule.

---

## IDEA-04 — Close out `make start-all` doc drift

- **Effort:** S
- **Scope:** api
- **PR strategy:** 1 trivial PR (may already be a no-op — see step 1).
- **Files:**
  - `/home/user/api/README.md`
  - `/home/user/api/CLAUDE.md`
- **Steps:**
  1. Re-confirm the state:
     ```
     grep -rn "start-all" /home/user/api /home/user/web
     ```
     Research already showed the only hits are: this ROADMAP entry
     and the explanatory note in `CLAUDE.md` line 29 ("README mentions
     `make start-all`; no such target exists"). `README.md` line 85
     already says `make start` (the correct command).
  2. Update the `CLAUDE.md` note to past tense (or drop it) since the
     premise is no longer true: "README.md previously mentioned
     `make start-all`; fixed in commit `<sha>`. Use `make start`."
  3. Update ROADMAP.md to mark IDEA-04 `done` in the same PR.
- **Verification:** `grep -rn "start-all" /home/user/api` returns nothing
  except the historical note (if kept).
- **Rollback:** revert.

---

## IDEA-05 — Split `web/src/services/index.tsx` (2275 LOC) into per-domain modules

- **Effort:** L
- **Scope:** web
- **PR strategy:** **6 sequential PRs**, one domain per PR. Do **not**
  try this as a single PR — every page in `web/src/pages` imports from
  `../services` and the diff would be unreviewable. Each PR moves one
  domain into its own file under `web/src/services/` and re-exports it
  through a new barrel `web/src/services/index.ts`. The legacy
  `index.tsx` shrinks by one slice per PR until it can be deleted.
- **Files (target end state):**
  - `/home/user/web/src/services/index.ts` — barrel re-exporting from
    every domain module + the shared axios client.
  - `/home/user/web/src/services/_client.ts` — the axios instance,
    `ApiError`, `safeHttpUrl` glue, CSRF interceptor (private).
  - `/home/user/web/src/services/auth.ts` — `getMe`, `updateMe`,
    `searchUsers`, `nuke`, `loginToGithub`, `authenticateGithub`,
    `loginToTwitch`, `authenticateTwitch`, `logout`.
  - `/home/user/web/src/services/blog.ts` — blog post CRUD.
  - `/home/user/web/src/services/admin-users.ts` — admin user + group
    + permission management.
  - `/home/user/web/src/services/settings.ts` — settings/secrets + metrics
    (DigitalOcean proxy).
  - `/home/user/web/src/services/printers.ts` — printers, gcode, stl,
    print-requests, print-jobs.
  - `/home/user/web/src/services/clips.ts` — submit, vote, leaderboard,
    awards, sections, browse, contributors, personal feed, search.
  - `/home/user/web/src/services/clips-admin.ts` — admin moderation,
    categories, mod settings, foryou settings.
  - `/home/user/web/src/services/comments.ts` — clip + blog comment
    CRUD + moderation + mutes.
  - `/home/user/web/src/services/types.ts` (optional) — shared `User`,
    `Comment`, etc., if circular-import risk shows up; otherwise leave
    types co-located with the function that owns them.
- **PR breakdown (in execution order):**
  - **PR 1 — extract shared client.** Move `ApiError`, axios instance,
    CSRF interceptor, base-URL helper, all toApiError glue into
    `_client.ts`. Create new `index.ts` that re-exports everything still
    in `index.tsx` plus the new client exports. Zero behavior change.
  - **PR 2 — auth + user domain.** Move auth/user/social-link/OAuth
    functions into `services/auth.ts`. Add re-exports in `index.ts`.
  - **PR 3 — blog + admin (users/groups/permissions).** Two related
    bundles, ~250 LOC combined.
  - **PR 4 — settings + metrics (the DigitalOcean block).**
  - **PR 5 — printers + gcode + stl + print-request + print-job.** Largest
    single slice (~700 LOC of source). Keep the four resource types in
    one file initially — splitting further is a follow-up.
  - **PR 6 — clips + clips-admin + comments + categories.** Delete the
    now-empty `index.tsx`; rename `index.ts` is already the entry point.
- **Steps (per PR):**
  1. Branch off `main`.
  2. Cut the functions from `index.tsx` into the new module. Imports
     from `_client.ts` for the axios instance + `ApiError`. **No call
     site changes** in `pages/`/`components/` — the barrel preserves
     `import { fn } from '../services'`.
  3. `npm run build` — must succeed.
  4. Manual smoke: `npm run dev`, log in, hit the affected dashboard page.
  5. Open PR. Title: `refactor(services): extract <domain> (IDEA-05 PR
     N/6)`.
- **Commands:**
  ```
  cd /home/user/web && npm run build
  cd /home/user/web && npm run dev   # smoke test in browser
  ```
- **Verification:**
  - `npm run build` clean after each PR.
  - The bundle size diff (`vite build` output) does not regress more
    than 2% — tree-shaking should keep totals equal.
  - For each PR, smoke-test the page that uses the extracted domain
    (e.g. PR 4 → `/dashboard/settings`).
- **Rollback:** revert the offending PR. Because each PR is additive
  (new file + barrel re-export, then deletes from `index.tsx`), reverting
  one in the middle still leaves the barrel intact — but the simplest
  rollback is "revert all unmerged PRs and abandon the split."
- **Notes:**
  - The barrel approach is the only way to keep page imports stable
    during the multi-PR rollout. After PR 6, a follow-up can be
    considered to move imports off the barrel onto direct module paths,
    but that's a separate IDEA-grade task (not in scope here).
  - `index.ts` vs `index.tsx`: the file currently has the `.tsx`
    extension only because TypeScript was happy with it; there is no
    JSX in it. New barrel can safely be `.ts`.

---

## IDEA-06 — Split `web/src/pages/DashboardSettings.tsx` (1257 LOC) into co-located subcomponents

- **Effort:** M
- **Scope:** web
- **PR strategy:** **2 PRs.** First moves the DigitalOcean section;
  second moves the Advanced + helpers. Splitting before IDEA-21 (mobile
  polish) is the entire point — the existing file is too large to
  responsively refactor in one go.
- **Files (target end state):**
  - `/home/user/web/src/pages/DashboardSettings.tsx` — page shell only:
    `DashboardSettingsPage` + `SettingsContent` (the state container
    that owns `settings`, `secrets`, `reload`, error/info banner).
  - `/home/user/web/src/pages/dashboard-settings/DigitalOceanSection.tsx`
    — `DigitalOceanSection`, `DigitalOceanAppsEditor`, `parseAppsSetting`,
    `CuratedSettingRow`, `CuratedSecretRow` (~600 LOC).
  - `/home/user/web/src/pages/dashboard-settings/AdvancedSection.tsx`
    — `AdvancedSection`, `AdvancedSettingsList`, `AdvancedSettingRow`,
    `AdvancedSettingCreate`, `AdvancedSecretsList`, `AdvancedSecretRow`,
    `AdvancedSecretCreate` (~400 LOC).
  - `/home/user/web/src/pages/dashboard-settings/helpers.ts`
    — `stringifyValueForInput`, `parseSettingValue`, `parseCoercedNumber`
    plus the `CURATED_*` constants if shared.
- **Steps (per PR):**
  1. Identify the section by its existing comment banner in the source
     (e.g. `// ─── DigitalOcean curated block ───`).
  2. Cut the functions into the new file. Re-export the entry-point
     component. Update the parent's `import`.
  3. Types stay co-located unless shared — `SectionProps` is shared
     with Advanced, so it can move into a small types file under the
     same directory.
  4. `npm run build`, then `npm run dev`, exercise the page.
- **Commands:**
  ```
  cd /home/user/web && npm run build
  ```
- **Verification:** save a setting, save a secret, delete one, refresh
  page — same behavior as before (the diff is move-only). React-DevTools
  component tree should show the new file paths.
- **Rollback:** revert. Pure UI; no persistence change.
- **Cross-ref:** Unblocks IDEA-21 (mobile polish).

---

## IDEA-07 — Add a test runner (both repos)

- **Effort:** L (combined across both repos)
- **Scope:** both
- **PR strategy:** **3 PRs**, two on api, one on web. Do **api first** —
  the api repo already has lint infra; mirroring its `package.json`
  script style on the web side is easier with a working api template.
- **Files (web):**
  - `/home/user/web/package.json` — add `vitest`, `@vitest/ui`,
    `jsdom`, `@testing-library/react`, `@testing-library/jest-dom` to
    `devDependencies`; add `test` + `test:watch` + `test:ui` scripts.
  - `/home/user/web/vitest.config.ts` — new; `environment: 'jsdom'`,
    `globals: true`, `setupFiles: ['./src/test/setup.ts']`.
  - `/home/user/web/src/test/setup.ts` — `import '@testing-library/jest-dom'`.
  - `/home/user/web/src/lib/url.test.ts` — first representative test;
    `safeHttpUrl` is a pure function, ideal smoke target.
  - `/home/user/web/.github/workflows/test.yaml` — run `npm test` on PRs.
- **Files (api):**
  - `/home/user/api/package.json` — add `vitest` (or stick with
    `node:test` + `tsx` for fewer deps); add `test` + `test:watch` scripts.
    Recommendation: **Vitest** to match web — single test framework
    across the project keeps the mental model small.
  - `/home/user/api/vitest.config.ts` — `environment: 'node'`,
    `globals: true`, `pool: 'forks'` (so each integration test gets
    a fresh DB connection).
  - `/home/user/api/src/test/setup.ts` — boots a fresh test DB
    connection per file.
  - `/home/user/api/docker-compose.test.yml` — minimal compose with a
    separate `postgres-test` service on a different port + DB name
    (`api_test_db`). Reuses the same image as production for parity.
  - `/home/user/api/src/services/error.test.ts` — first representative
    test: `AppError.badRequest()` → known shape. Pure, no DB.
  - `/home/user/api/src/services/comment.test.ts` (later) — first
    integration test: insert + soft-delete + restore happy path against
    `postgres-test`.
  - `/home/user/api/.github/workflows/test.yaml` — boot the test compose,
    run migrations, run `npm test`.
- **Steps (api, PR 1 — pure-unit harness):**
  1. Install vitest + add scripts.
  2. Write `services/error.test.ts` covering each `AppError.*` constructor.
  3. Wire `.github/workflows/test.yaml` for unit tests only (no DB).
  4. `npm test` locally — green.
- **Steps (api, PR 2 — integration harness):**
  1. Add `docker-compose.test.yml`. `make test-up` / `make test-down`
     targets.
  2. Add `src/test/setup.ts` that connects to the test DB and runs
     `migrate:up` once per file (or once per worker via `globalSetup`).
  3. Write the first integration test (`comment.test.ts` happy path).
  4. Extend the CI workflow to bring up the compose, run migrations,
     run integration tests, tear down.
- **Steps (web, PR 1):**
  1. Install vitest + RTL + jsdom.
  2. Add `vitest.config.ts` + setup file.
  3. Write `lib/url.test.ts` with cases for `https://`, `http://`,
     `javascript:` (must reject), missing scheme, malformed.
  4. Wire `.github/workflows/test.yaml`.
- **Commands:**
  ```
  cd /home/user/web && npm install -D vitest @vitest/ui jsdom \
    @testing-library/react @testing-library/jest-dom
  cd /home/user/web && npm test

  cd /home/user/api && npm install -D vitest
  cd /home/user/api && docker compose -f docker-compose.test.yml up -d postgres-test
  cd /home/user/api && npm test
  ```
- **Verification:** `npm test` exit-codes are the gate. CI workflow
  green on the PR.
- **Rollback:** revert. No prod impact.
- **Cross-ref:** Once landed, every other section in this doc gains an
  implicit "add a test for the new code path" step.

---

## IDEA-08 — Add ESLint + Prettier to web

- **Effort:** M
- **Scope:** web
- **PR strategy:** **2 PRs.** PR A introduces config + scripts + formats
  the whole tree with Prettier (mechanical, large diff); PR B introduces
  ESLint with the same flat-config shape as api, fixes the first round
  of warnings, sets the rest to warnings (not errors) so the PR doesn't
  balloon.
- **Files:**
  - `/home/user/web/package.json` — add `eslint`,
    `@eslint/js`, `typescript-eslint`, `eslint-plugin-react`,
    `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`,
    `prettier`, `eslint-config-prettier` (turns off ESLint rules that
    conflict with Prettier).
  - `/home/user/web/eslint.config.mjs` — mirror api's flat-config shape
    (see `/home/user/api/eslint.config.mjs`), add the React-specific
    plugins. Ignore `dist/`, `node_modules/`, `tailwind.config.js`,
    `vite.config.js`.
  - `/home/user/web/.prettierrc.json` — `{ "semi": true,
    "singleQuote": false, "trailingComma": "es5", "printWidth": 100 }`
    (match the existing file style — eyeballing `services/index.tsx`
    confirms double-quotes, semicolons, ~100 col).
  - `/home/user/web/.prettierignore` — `dist`, `node_modules`,
    `package-lock.json`.
  - `/home/user/web/.github/workflows/lint.yaml` — run `npm run lint`
    + `npm run format:check` on PRs.
- **Steps (PR A — Prettier):**
  1. Install prettier.
  2. Add config + ignore file.
  3. Run `npx prettier --write .` once. **Huge diff** — expected.
  4. Add scripts: `"format": "prettier --write ."`, `"format:check":
     "prettier --check ."`.
  5. Commit the format-only changes separately so future blame is sane.
- **Steps (PR B — ESLint):**
  1. Install eslint deps.
  2. Add `eslint.config.mjs` mirroring api's structure.
  3. Add scripts: `"lint": "eslint ."`, `"lint:fix": "eslint . --fix"`.
  4. `npm run lint:fix` — auto-fix everything possible.
  5. For remaining warnings, **do not** suppress them inline — leave the
     warning count visible. A follow-up IDEA can drive it to zero.
  6. CI workflow runs `lint` + `format:check`. Fail on errors only.
- **Commands:**
  ```
  cd /home/user/web && npx prettier --write .
  cd /home/user/web && npm run lint
  ```
- **Verification:** `npm run lint && npm run format:check` exit 0 on PR B.
- **Rollback:** revert. Pure tooling.
- **Cross-ref:** Unblocks IDEA-27 (pre-commit hooks have nothing to run
  on web until this lands).

---

## IDEA-09 — Streamclips discovery (categories UI / contributor follow)

- **Effort:** M (per sub-feature)
- **Scope:** both
- **PR strategy:** **Blocked on design decision** in CONCEPT.md — option
  (a) category browse UI vs option (b) contributor follow + personal
  feed. Server side for (a) is already in place (`twitch_category`,
  `award_category` tables from migration `_035`). Once CONCEPT.md picks,
  the plan is roughly:
  - **If (a):** 1 PR — new `pages/streamclips/Categories.tsx`, new API
    method `listCategories()` already exists (`adminListCategories` is
    admin-only; need a public `GET /categories?section=...`). Route
    addition in `routes/categories.ts`.
  - **If (b):** 2 PRs — server-side `user_follow` table + endpoints; SPA
    follow button on contributor cards + personal feed page.
- **Files:** TBD post-decision.
- **Verification:** TBD post-decision.

---

## IDEA-10 — Blog: scheduled publishing + private draft preview links

- **Effort:** M
- **Scope:** both
- **PR strategy:** 1 PR if scheduling and preview-tokens are wanted
  together; else 2 PRs (scheduling first — simpler; preview tokens
  second — needs a tokens table or signed-URL helper).
- **Files (api):**
  - **Migration** via
    `cd /home/user/api && make migrate-create name=blog_scheduled_publish`
    — adds `publish_at timestamptz` to `blog_post`, drops `publish boolean`
    or keeps it as a derived view. Decide in CONCEPT.md.
  - `/home/user/api/src/services/blog.ts` — update `list`/`get` to
    treat a post as "published" if `publish_at IS NOT NULL AND publish_at <= now()`.
  - `/home/user/api/src/services/blog.ts` — add `getByPreviewToken(token)`
    that bypasses publish gating after HMAC-verifying the token.
  - `/home/user/api/src/controllers/blog.ts` — new
    `getPreview(req, res)` mounted at `GET /blog/preview/:slug?token=...`.
  - `/home/user/api/src/routes/blog.ts` — register preview route BEFORE
    the `/:slug` catch-all and BEFORE `/blog/rss.xml` is registered in
    `routes/index.ts` (same gotcha as the RSS feed).
- **Files (web):**
  - `/home/user/web/src/services/blog.ts` (after IDEA-05 PR 3 lands) —
    add `getBlogPostPreview(slug, token)`.
  - `/home/user/web/src/pages/BlogPost.tsx` — detect `?preview=<token>`
    query and call the preview endpoint instead of the public one.
  - `/home/user/web/src/pages/BlogEdit.tsx` — "Copy preview link" button.
- **Steps:**
  1. `make migrate-create name=blog_scheduled_publish` and write the
     migration (add column, backfill `publish_at = updated_at` for rows
     where `publish=true`).
  2. Update service layer.
  3. Add preview token helper (HMAC over `slug + secret`, no DB row needed).
  4. Wire SPA edit page button + read path.
- **Commands:**
  ```
  cd /home/user/api && make migrate-create name=blog_scheduled_publish
  cd /home/user/api && npm run migrate:up
  ```
- **Verification:**
  - Create a draft, set `publish_at` to "now + 5 min", visit public
    `/blog/<slug>` → 404. Wait 5 min, retry → 200.
  - Copy preview link, open in incognito → 200 even before `publish_at`.
- **Rollback:** `npm run migrate:down` (one migration). Revert code PR.

---

## IDEA-11 — Web Push notifications when a print finishes

- **Approach sketch (P3):**
  - VAPID key generation, store in `app_secret` table; `service-worker.js`
    registers push subscription.
  - New `user_push_subscription` table (endpoint + keys, per device).
  - `printJobService.markFinished()` calls a new
    `pushService.notifyOwner(printerId, payload)`.
  - SPA opt-in toggle on `pages/DashboardPrinters.tsx`.
  - Effort: M. Touches both repos. Defer until owner count justifies.

---

## IDEA-12 — Observability (Sentry + structured logger)

- **Effort:** L (combined across both repos)
- **Scope:** both
- **PR strategy:** **4 PRs** — kept narrow to make each diff reviewable:
  - **PR 1 (api):** introduce `pino` and a `getLogger(module)` helper
    in `src/services/logger.ts`. Replace `console.*` call sites
    module-by-module — or, since the count is only 23 occurrences,
    in one PR. Recommendation: one PR for the swap; only split if
    review feedback asks for it.
  - **PR 2 (api):** wire Sentry (`@sentry/node`) into `app.ts`
    error handler + as an `errorHandler` Express middleware before the
    custom one. Init in `app.ts` ahead of all middleware so unhandled
    rejections are captured.
  - **PR 3 (web):** wire Sentry browser SDK in `main.tsx`. Configure
    `BrowserTracing` with the React Router instrumentation. Source-map
    upload in the docker build stage.
  - **PR 4 (both):** documentation + dashboard pruning — point an
    `app_secret` row at the DSN, document the integration in the README.
- **Files (api):**
  - `/home/user/api/package.json` — add `pino`, `pino-http`, `@sentry/node`.
  - `/home/user/api/src/services/logger.ts` — replace the bespoke
    middleware. Export both the request logger (still middleware) and
    a `getLogger(name)` factory.
  - Call sites for `console.*` swap (23 occurrences — verified during
    research): `controllers/agent.ts:65`, `controllers/user.ts:243`,
    `app.ts:126,137,142,143`, `services/bootstrap.ts:60,67,93`,
    `services/metrics.ts:175,181,192,203,217`, `services/system.ts:69,
    286,316,329,339`, `services/persistence.ts:10`, `routes/github.ts:176`,
    `services/user.ts:448`.
  - `/home/user/api/src/app.ts` — Sentry init (must be first), Sentry
    request handler middleware (very early), error handler middleware
    (before `system.errorHandler`).
- **Files (web):**
  - `/home/user/web/package.json` — add `@sentry/react`.
  - `/home/user/web/src/main.tsx` — `Sentry.init` before
    `ReactDOM.createRoot`. Add `Sentry.ErrorBoundary` around `<RouterProvider>`.
  - `/home/user/web/Dockerfile` — source-map upload step in the
    builder stage (optional; gated on env var).
- **Steps (PR 1):**
  1. `npm install pino pino-http`.
  2. Replace `services/logger.ts` body with `pino-http` middleware;
     export `getLogger`.
  3. Sweep `console.*` call sites. Pattern:
     ```
     const log = getLogger('bootstrap');
     log.info({ email }, 'admin email has no user yet');
     ```
  4. `npm run lint && npm run build`.
  5. `make run` and watch the log output — confirm structured JSON
     in `docker compose logs api`.
- **Steps (PRs 2/3):** standard Sentry boot. Store DSN in
  `app_secret` (`sentry.dsn`) — surfaced by the existing settings page.
- **Commands:**
  ```
  cd /home/user/api && npm install pino pino-http @sentry/node
  cd /home/user/api && grep -rn "console\\." src/    # should drop to 0
  cd /home/user/web && npm install @sentry/react
  ```
- **Verification:**
  - PR 1: `make run` and tail logs — output is one JSON object per
    line, includes `req.id` correlation.
  - PR 2: throw a test exception from a debug route, see it in Sentry
    dashboard within 30s.
  - PR 3: trigger a deliberate render error behind a feature flag,
    see it in Sentry.
- **Rollback:** revert per PR. PR 1 is the largest blast radius (every
  `console.*` removed); if logging breaks, revert and ship a small
  fix-forward PR.
- **Cross-ref:** Once PR 2 lands, IDEA-17 becomes measurable.

---

## IDEA-13 — Image pipeline for streamclip thumbnails

- **Effort:** M
- **Scope:** both
- **PR strategy:** 1 PR per phase — phase 1 = server-side WebP/AVIF
  generation behind a media-cache table; phase 2 = SPA `srcset` +
  lazy-loading consumer.
- **Files:**
  - **Migration:** `make migrate-create name=media_cache` — table
    `media_cache(source_url text pk, format text, width int, bytes bytea or url text, generated_at)`.
  - `/home/user/api/src/services/media-cache.ts` — new.
  - `/home/user/api/src/controllers/asset-controller.ts` — extend with
    a `/thumbnail` route that returns the cached variant or 302s to
    origin on miss while it backfills.
  - `/home/user/web/src/components/streamclips/ClipCard.tsx` —
    `<img srcset>` consumer.
- **Steps:**
  1. Decide storage: blob in Postgres vs. R2/S3. **Blocked on design
     decision** in CONCEPT.md (cost vs. complexity trade-off). Until
     then, plan is for Postgres-blob in a private bucket-style table.
  2. Migration.
  3. Service + controller.
  4. SPA wiring.
- **Verification:** Lighthouse score for `/streamclips/` improves on
  the "Properly size images" + "Serve images in next-gen formats" audits.
- **Rollback:** `npm run migrate:down` + revert code.

---

## IDEA-14 — HTTP/3 + tighten static cache headers (mostly verification)

- **Effort:** S
- **Scope:** web
- **PR strategy:** 1 PR, possibly a no-op confirming current state.
- **Files:**
  - `/home/user/web/Caddyfile` — verify `protocols h1 h2 h3` is
    configured (or add an `{ servers { protocols h1 h2 h3 } }` global
    block). Caddy 2.x has HTTP/3 implicit on TLS terminations but the
    DigitalOcean LB does the TLS, so H3 needs explicit confirmation.
- **Steps:**
  1. `curl -I --http3 https://broiler.dev/` (needs curl built with
     HTTP/3) — if it returns 200, IDEA can be closed without code.
  2. Inspect cache headers for `/assets/*.js`,
     `/assets/*.css`, `/favicon.ico`. Already long-term per Caddyfile;
     just confirm.
  3. If H3 is not reachable, file an infra ticket (the LB terminates
     TLS — Caddy may not be the right knob; this might be a
     DigitalOcean App Platform / LB setting).
- **Verification:** Lighthouse "Use HTTP/2" passes; curl confirms H3.
- **Rollback:** trivial.

---

## IDEA-16 — Postgres backup beyond DigitalOcean snapshots (PITR)

- **Approach sketch (P2, infra not app):**
  - `pgbackrest` or WAL-G as a sidecar.
  - Not in either of these two repos — belongs in the infra/deployment
    repo (out of tree). File a ticket there with the link to this IDEA.
  - Effort: M. Cost: an S3-compatible bucket for WAL archive.

---

## IDEA-17 — Soften `services/persistence.ts` `process.exit(5)` on Redis errors

- **Effort:** S
- **Scope:** api
- **PR strategy:** 1 PR.
- **Files:**
  - `/home/user/api/src/services/persistence.ts` (currently 34 lines —
    `onError` immediately `process.exit(5)` on any error event from
    either the Redis client or the PG pool).
- **Steps:**
  1. Refactor `onError` to take an `(err, source: 'redis' | 'db')`
     and a context flag indicating whether the error is auth-hard
     (`WRONGPASS`, `NOAUTH`, `ENOTFOUND` on a hostname we cannot
     resolve at all) vs. transient (`ECONNRESET`, `ETIMEDOUT`,
     `Connection lost`). Only auth-hard → `process.exit(5)`.
  2. Configure the Redis client with bounded reconnect:
     ```
     createClient({
       url: config.redisUrl,
       socket: {
         reconnectStrategy: (retries) =>
           retries > 10 ? new Error('giving up') : Math.min(retries * 200, 3000),
       },
     })
     ```
     The Redis v5 client already supports this — confirm against the
     installed version.
  3. Add an `info`-level log on every reconnect attempt so the
     observability layer (IDEA-12) can graph the rate.
  4. Keep `SIGINT` → graceful shutdown (separate from `onError`).
- **Verification:**
  - Boot the stack, kill the Redis container, watch the api logs —
    the api must log reconnect attempts and **not** exit. Restart
    Redis, watch the api recover.
  - `/health` returns 503 during the outage (cache check fails) and
    flips back to 200 after recovery.
- **Rollback:** revert. Persistence is the most sensitive file in the
  repo; ship behind a small canary deploy and watch the restart rate.
- **Cross-ref:** Best landed after IDEA-12 PR 2 (Sentry) so reconnect
  events are measurable.

---

## IDEA-18 — Light-theme toggle

- **Approach sketch (P3):**
  - Add `data-theme` attribute on `<html>`, toggle from a button in
    the header. Persist in `localStorage`.
  - Tailwind v4 — use `@media (prefers-color-scheme: light)` cheap
    initial; the real cost is auditing every page for legible light
    styles (and there are many hand-rolled component classes in
    `style.css`).
  - Effort: M (audit-heavy).

---

## IDEA-19 — Loading skeletons instead of spinners

- **Effort:** S
- **Scope:** web
- **PR strategy:** 1 PR introducing `<Skeleton>` + 1 follow-up per
  dashboard list (do them as small, lazy follow-ups, not in one mega-PR).
- **Files:**
  - `/home/user/web/src/components/Skeleton.tsx` — new. Just a `<div>`
    with a Tailwind animation utility and `aria-hidden`. Variants:
    line, block, avatar.
  - First consumer: `/home/user/web/src/pages/DashboardClips.tsx`
    (or wherever the largest list lives) — replace its `<Spinner>` with
    a `Skeleton` list of N rows.
- **Steps:**
  1. Implement Skeleton.
  2. Replace one spinner.
  3. Document the pattern in component header doc comment.
- **Verification:** Visual.
- **Rollback:** revert.

---

## IDEA-20 — axe-core a11y checks into Lighthouse CI

- **Effort:** S
- **Scope:** web
- **PR strategy:** 1 PR.
- **Files:**
  - `/home/user/web/lighthouserc.json` — set `extends: 'lighthouse:default'`
    if not already; ensure `accessibility` category is at threshold 0.9
    (already is per ROADMAP).
  - `/home/user/web/.github/workflows/lighthouse.yaml` — add a second
    job step that runs `@axe-core/cli` against the built `dist/` served
    locally.
  - `/home/user/web/package.json` — add `@axe-core/cli` to devDeps.
- **Steps:**
  1. Install axe-core/cli.
  2. Add script: `"a11y": "axe http://localhost:4173 --exit"`.
     (`4173` is `vite preview`'s default port.)
  3. Workflow step: `npm run build && npx vite preview &`, then
     `npm run a11y`.
- **Verification:** axe run produces a report; non-zero exit on
  violations.
- **Rollback:** revert.

---

## IDEA-21 — Mobile dashboard polish (DashboardSettings @ 360px)

- **Effort:** M
- **Scope:** web
- **PR strategy:** 1 PR, **only after IDEA-06 lands**.
- **Files:**
  - `/home/user/web/src/pages/dashboard-settings/DigitalOceanSection.tsx`
    (created in IDEA-06).
  - `/home/user/web/src/pages/dashboard-settings/AdvancedSection.tsx`
    (created in IDEA-06).
  - Possibly `style.css` for shared `.panel`/`.section-panel` tweaks.
- **Steps:**
  1. Use Chrome DevTools device emulation at 360px. List every
     visible overflow / cramped row.
  2. Add `flex-wrap` + `min-w-0` patterns. The hand-written `.panel`
     class is the usual culprit — check `style.css`.
  3. Touch targets ≥ 44px tall.
- **Verification:** Visual at 360px. Run Lighthouse mobile + a11y
  audit on the page.
- **Rollback:** revert. Pure CSS/JSX.
- **Cross-ref:** Blocked on IDEA-06.

---

## IDEA-22 — Emoji reactions on comments

- **Approach sketch (P3):**
  - New `comment_reaction` table `(comment_id, user_id, emoji, created_at)`
    with PK `(comment_id, user_id, emoji)` (one of each per user).
  - `CommentService` adds `addReaction`/`removeReaction`.
  - Route: `POST/DELETE /comments/:id/reactions`.
  - SPA renders an emoji-picker on the existing comment component.
  - Effort: M. Soft value — defer.

---

## IDEA-23 — 2FA for admin accounts via TOTP

- **Effort:** L
- **Scope:** both
- **PR strategy:** **3 PRs.**
  - **PR 1 (api):** migration + `userTotp` service + enroll endpoint.
  - **PR 2 (api):** verify-on-login flow + middleware gate
    (`require2FAForAdmin`).
  - **PR 3 (web):** SPA enroll page, login flow handling the verify
    step, recovery code download.
- **Files:**
  - **Migration:** `make migrate-create name=user_totp_secret` — new
    table:
    ```
    user_totp_secret (
      user_id uuid pk references user(id) on delete cascade,
      secret_ciphertext bytea,
      backup_code_hashes text[],
      enabled boolean default false,
      enrolled_at timestamptz,
      last_used_at timestamptz
    )
    ```
  - `/home/user/api/src/services/user-totp.ts` — new. Wraps `otpauth`.
  - `/home/user/api/src/services/crypto.ts` — already exists; reuse
    `encrypt`/`decrypt` for `secret_ciphertext` (AES-GCM same as the
    secrets table).
  - `/home/user/api/src/controllers/user.ts` — `enrollTotp`,
    `verifyTotp`, `disableTotp`.
  - `/home/user/api/src/routes/user.ts` — wire the endpoints.
  - `/home/user/api/src/middleware/require2FA.ts` — new. Composes with
    `requirePermission`.
  - `/home/user/api/src/services/system.ts` — `loginHandler` returns a
    `{ needs2FA: true, challengeToken }` shape when the user has TOTP
    enabled; SPA POSTs to `/login/2fa` to exchange the challenge for a
    session.
  - `/home/user/web/src/pages/Dashboard2FA.tsx` — new enroll page
    (QR code + recovery codes).
  - `/home/user/web/src/services/auth.ts` (after IDEA-05 PR 2) — extend
    `authenticate*` flows with the 2FA challenge step.
- **Steps:**
  1. **Blocked on design decision** in CONCEPT.md — confirm the
     encryption-at-rest scheme for `secret_ciphertext`. Reusing the
     existing `crypto.ts` (AES-256-GCM with key from `SECRETS_KEY` env)
     is the obvious answer; flag for confirmation since it puts TOTP
     secrets under the same KEK as DigitalOcean tokens.
  2. Migration.
  3. Service: generate secret, store ciphertext, expose verify(code).
  4. Backup codes: 10 codes, store as bcrypt hashes (NOT plain).
  5. Login flow plumb-through.
  6. SPA enroll + verify-on-login.
- **Commands:**
  ```
  cd /home/user/api && make migrate-create name=user_totp_secret
  cd /home/user/api && npm install otpauth bcrypt @types/bcrypt
  ```
- **Verification:**
  - Enroll a test admin; scan QR with Google Authenticator; log out;
    log in — must demand the 6-digit code.
  - Burn a backup code; log in with it; confirm code is one-shot
    (second use fails).
  - Admin without TOTP enabled cannot access routes gated by
    `require2FA` middleware.
- **Rollback:** `npm run migrate:down` rolls back; revert PRs in
  reverse order. Existing admins with TOTP enrolled would be locked out
  if their secret column is dropped — communicate downtime, or stage
  rollback to disable the middleware gate first.

---

## IDEA-24 — Generalise admin audit log

- **Effort:** M
- **Scope:** api
- **PR strategy:** **2 PRs.**
  - **PR 1:** add the `audit_log` table + `auditService.log(...)` helper.
    Wire one existing call site (the comment restore — replaces the
    per-resource columns added in `_039`).
  - **PR 2:** wire the remaining call sites (permission grants, print
    moderation, user anonymisation).
- **Files:**
  - **Migration 1:** `make migrate-create name=audit_log_table`:
    ```
    audit_log (
      id uuid pk default gen_random_uuid(),
      event_type text not null,      -- e.g. 'comment.restored'
      actor_user_id uuid references user(id) on delete set null,
      target_type text,               -- e.g. 'comment'
      target_id text,                 -- not uuid; supports composite IDs
      payload jsonb,                  -- arbitrary structured context
      created_at timestamptz default now()
    );
    create index audit_log_actor on audit_log (actor_user_id, created_at desc);
    create index audit_log_event on audit_log (event_type, created_at desc);
    create index audit_log_target on audit_log (target_type, target_id, created_at desc);
    ```
  - **Migration 2 (PR 2):** `make migrate-create name=audit_log_drop_comment_restore_cols`
    — drops `comment.restored_at`, `restored_by_user_id`,
    `last_deletion_reason` columns added in `_039` once the new table
    is fully backfilled. **Backfill must happen first** in this same
    migration's `up`: copy existing rows to `audit_log` then drop the
    columns. Make sure `down` re-adds the columns and copies back.
  - `/home/user/api/src/services/audit.ts` — new. Public `log(...)`,
    `query({ eventType?, actor?, target?, since?, limit? })`.
  - `/home/user/api/src/services/comment.ts` — replace
    `restored_at`/`restored_by_user_id` UPDATEs with
    `auditService.log({ eventType: 'comment.restored', ... })`.
    Read path joins audit_log when surfacing the restore badge.
  - Call sites for PR 2:
    - `/home/user/api/src/services/permissions.ts` — grant/revoke.
    - `/home/user/api/src/services/group.ts` — group permission grants.
    - `/home/user/api/src/services/clip.ts` — `adminSetClipStatus`.
    - `/home/user/api/src/services/clip-report.ts` — `adminResolveReport`.
    - `/home/user/api/src/services/user.ts` — `anonymizeUser`.
- **Steps:**
  1. Migration 1 + service.
  2. Replace one call site (comment.restored) — keep the columns for
     one release while the new log proves out.
  3. PR 2 — sweep remaining call sites + run migration 2 to drop the
     legacy columns.
- **Commands:**
  ```
  cd /home/user/api && make migrate-create name=audit_log_table
  cd /home/user/api && make migrate-create name=audit_log_drop_comment_restore_cols
  cd /home/user/api && npm run migrate:up
  ```
- **Verification:**
  - Restore a moderated comment via the admin UI; SELECT * FROM
    `audit_log` shows the row.
  - Grant a permission; same.
  - The "restored by mod" badge in the SPA still renders correctly
    (i.e. the join from `comment` to `audit_log` works).
- **Rollback:** `npm run migrate:down` reverses one migration at a time.
  Down-migration of #2 re-adds the columns and backfills from
  `audit_log` for `event_type='comment.restored'`.

---

## IDEA-25 — CSP report-to endpoint

- **Effort:** S
- **Scope:** both
- **PR strategy:** 1 PR.
- **Files:**
  - `/home/user/api/src/controllers/csp-report.ts` — new. Accepts
    `POST /csp-report` with body type `application/csp-report` or
    `application/reports+json`. Logs the violation (use the structured
    logger from IDEA-12 if landed; else `console.warn`). Returns 204.
  - `/home/user/api/src/routes/index.ts` — register the route before
    the auth middleware (CSP reports are unauthenticated).
  - `/home/user/api/src/app.ts` — add an
    `express.raw({ type: 'application/csp-report', limit: '64kb' })`
    handler scoped to that one path.
  - `/home/user/web/Caddyfile` — extend the existing CSP with
    `report-uri https://api.broiler.dev/prod/csp-report;` and a
    `Reporting-Endpoints` header.
- **Steps:**
  1. Backend route + raw body parser.
  2. Caddyfile CSP edit.
  3. Deploy; deliberately load a blocked external script in dev tools
     to fire a report; verify it lands.
- **Verification:** SELECT from logs / Sentry for `csp.violation`
  event_type within 1 minute of the test.
- **Rollback:** revert. Pure additive.

---

## IDEA-27 — Pre-commit hooks via husky + lint-staged

- **Effort:** S
- **Scope:** both
- **PR strategy:** 1 PR per repo, **api first** (lint config already
  exists); web second (requires IDEA-08 landed).
- **Files (api):**
  - `/home/user/api/package.json` — add `husky`, `lint-staged` to
    devDeps. Add `"prepare": "husky"` script.
  - `/home/user/api/.husky/pre-commit` — new. Single line:
    `npx lint-staged`.
  - `/home/user/api/.lintstagedrc.json` — new:
    ```
    {
      "*.ts": ["eslint --fix"]
    }
    ```
- **Files (web):** Same shape; add `"*.{ts,tsx,css,json}":
  ["prettier --write", "eslint --fix"]` once IDEA-08 lands.
- **Steps:**
  1. Install deps.
  2. Add files, run `npx husky init` (or write `.husky/pre-commit` by
     hand — newer husky supports that).
  3. Make a test commit — confirm the hook runs.
- **Commands:**
  ```
  cd /home/user/api && npm install -D husky lint-staged
  cd /home/user/api && npx husky init
  ```
- **Verification:** edit a file with a known lint error, attempt to
  commit — must block.
- **Rollback:** delete `.husky/`, remove the `prepare` script. Existing
  developers' clones won't pick up the removal until `npm i` next time.
- **Cross-ref:** Web side blocked on IDEA-08.

---

## IDEA-28 — Replace Dependabot with Renovate

- **Effort:** S
- **Scope:** both
- **PR strategy:** 1 PR per repo. **Do after IDEA-03** — drain the
  backlog first so the migration doesn't inherit it.
- **Files:**
  - `/home/user/api/renovate.json5` — new. Configure groups:
    `typescript-eslint`, `@types/*`, all minor/patch deps in one weekly
    group; major upgrades each get their own PR.
  - `/home/user/api/.github/dependabot.yml` — delete.
  - Same for `/home/user/web`.
- **Steps:**
  1. Install Renovate GitHub App on `3roiler` org.
  2. Add renovate config to each repo.
  3. Delete dependabot.yml.
  4. Watch the first Renovate run; tune groups.
- **Verification:** Renovate opens its first PR within 24h; no
  Dependabot PRs are filed for that week.
- **Rollback:** restore `dependabot.yml`; remove `renovate.json5`.

---

## IDEA-29 — PR template + Issue templates

- **Effort:** S
- **Scope:** both
- **PR strategy:** 1 PR per repo.
- **Files:**
  - `/home/user/api/.github/PULL_REQUEST_TEMPLATE.md` — new.
  - `/home/user/api/.github/ISSUE_TEMPLATE/bug.yml` — new.
  - `/home/user/api/.github/ISSUE_TEMPLATE/feature.yml` — new.
  - `/home/user/api/.github/ISSUE_TEMPLATE/config.yml` — `blank_issues_enabled: false`.
  - Mirror for `/home/user/web`.
- **Steps:**
  1. Write the PR template with sections: Summary, Linked IDEA-NN,
     Testing, Rollback.
  2. Bug template asks for repro + expected/actual + env (dev / prod).
  3. Feature template asks for "Why now?" and links to ROADMAP.md.
- **Verification:** open a test PR / issue — template appears.
- **Rollback:** delete files.

---

## IDEA-30 — OpenAPI spec for the API

- **Effort:** L
- **Scope:** api
- **PR strategy:** **2 PRs.**
  - **PR 1:** introduce `zod` for request validation. Pick 3
    representative endpoints (one each: GET, POST, multipart upload)
    and migrate them. Keep `assertUuid` etc. for the rest.
  - **PR 2:** roll out zod across all 17 route files
    (`admin.ts`, `agent.ts`, `blog.ts`, `categories.ts`,
    `clips-admin.ts`, `clips.ts`, `gcode.ts`, `github.ts`, `index.ts`,
    `metrics.ts`, `print-job.ts`, `print-request.ts`, `printer.ts`,
    `settings.ts`, `stl.ts`, `twitch.ts`, `user.ts`). Add
    `zod-to-openapi`. Generate `openapi.json` in a build step.
- **Files:**
  - `/home/user/api/package.json` — add `zod`, `@asteasolutions/zod-to-openapi`.
  - `/home/user/api/src/lib/zod.ts` — new. Wraps the registry.
  - Per-route: `/home/user/api/src/routes/*.ts` + matching controllers
    pick up `parseBody(schema)` / `parseQuery(schema)` helpers.
  - `/home/user/api/src/openapi.ts` — new. Builds the spec from the
    registry.
  - `/home/user/api/src/app.ts` — serve at `GET /openapi.json` (gated
    by env flag if you don't want it public).
- **Steps:**
  1. Add zod; convert 3 endpoints (blog post create, user-search GET,
     gcode upload).
  2. Add zod-to-openapi + the generator script (`scripts/build-openapi.ts`).
  3. Sweep remaining routes one-by-one — each route is a tiny PR or
     a batch of 3 related routes per PR.
- **Verification:**
  - `curl localhost:3000/api/openapi.json | jq '.paths | keys | length'`
    grows monotonically as routes are migrated.
  - Spectral lint passes on the generated spec.
- **Rollback:** revert per-PR. Zod additions are backward-compatible
  with existing call sites — the rollback risk is in the spec
  generator, not the route handlers.

---

## IDEA-31 — RSS feed for streamclips

- **Effort:** S
- **Scope:** api
- **PR strategy:** 1 PR.
- **Files:**
  - `/home/user/api/src/controllers/rss.ts` — extend with a
    `clipFeed(req, res)` analogous to the existing `feed`.
  - `/home/user/api/src/routes/index.ts` — register
    `router.get('/clips/rss.xml', rssController.clipFeed)` **BEFORE**
    `router.use('/clips', clips)`. Same gotcha as the blog feed —
    documented in api/CLAUDE.md.
  - `/home/user/web/Caddyfile` — add a `handle /streamclips/rss.xml`
    that reverse-proxies to the api `/prod/clips/rss.xml`.
  - `/home/user/web/index.html` — add a `<link rel="alternate"
    type="application/rss+xml" href="/streamclips/rss.xml">` next to
    the existing blog one (if present).
- **Steps:**
  1. Copy the blog feed shape, swap the service call to
     `clipService.list({ status: 'approved', limit: 50 })` (or whatever
     the equivalent is — read `clip.ts` first to find the right helper).
  2. Register the route in the correct position.
  3. Caddyfile rewrite.
- **Verification:** `curl https://broiler.dev/streamclips/rss.xml` —
  valid RSS 2.0 XML.
- **Rollback:** revert.

---

## IDEA-32 — Postgres FTS search across blog + streamclips

- **Effort:** M
- **Scope:** both
- **PR strategy:** **2 PRs.**
  - **PR 1 (api):** add `search_vector tsvector GENERATED ALWAYS AS
    (...)` columns + GIN indices to `blog_post` and `clip` (and any
    related searchable tables). Expose `GET /search?q=` returning
    unified results.
  - **PR 2 (web):** SPA search page with debounced input.
- **Files:**
  - **Migration:** `make migrate-create name=search_vectors`. Generated
    columns require Postgres 12+ (compose uses 18.1; fine). Example:
    ```
    alter table blog_post
      add column search_vector tsvector generated always as (
        to_tsvector('german', coalesce(title,'') || ' ' || coalesce(body,''))
      ) stored;
    create index blog_post_search_idx on blog_post using gin (search_vector);
    ```
  - `/home/user/api/src/services/search.ts` — new.
  - `/home/user/api/src/controllers/search.ts` — new.
  - `/home/user/api/src/routes/index.ts` — register `/search`.
  - `/home/user/web/src/pages/Search.tsx` — new.
  - `/home/user/web/src/services/search.ts` (after IDEA-05) — new.
- **Steps:**
  1. Decide German vs English dictionary — **flag for CONCEPT.md** if
     the blog has mixed-language content.
  2. Migration, service, controller.
  3. SPA page.
- **Verification:** `SELECT title FROM blog_post WHERE search_vector @@
  websearch_to_tsquery('german', 'foo bar')` returns ranked rows.
- **Rollback:** `npm run migrate:down` drops the generated columns +
  indices. Generated columns drop cleanly.
- **Cross-ref:** Doing this before IDEA-09 and IDEA-13 means a re-roll
  of the vector when category metadata + alt text get normalised. Not
  a hard blocker.

---

## IDEA-33 — Newsletter signup (Listmonk or similar)

- **Approach sketch (P3):**
  - External system (Listmonk container + Postgres + worker for sending).
  - SPA signup form posts to api → api proxies to Listmonk's REST.
  - Operational cost: deliverability, bounce handling, GDPR consent
    log.
  - Effort: L (mostly ops, not code). Defer until audience justifies.

---

## Execution order recommendation

This is the only place in this doc that does cross-IDEA orchestration.

**Sprint 0 — one afternoon, all P0:**

1. IDEA-04 — close the doc-drift first, smallest blast radius.
2. IDEA-01 — drop dead deps.
3. IDEA-17 — soften `process.exit(5)`. Real production-stability win;
   ship before IDEA-12 so the metric to validate it (restart rate)
   is even measurable.
4. IDEA-03 — Dependabot merge train. Last in Sprint 0 because the Docker
   base bump (#75) intersects IDEA-02.

**Sprint 1 — tooling foundation, before any big refactor:**

5. IDEA-08 — ESLint + Prettier on web. Two PRs.
6. IDEA-27 — pre-commit hooks (api side first, then web after #5).
7. IDEA-02 — Node version harmonization (resolves the question raised
   by IDEA-03 PR #75).
8. IDEA-29 — PR/issue templates. Cheap. Helps the rest of the work.

**Sprint 2 — test floor + the big web split:**

9. IDEA-07 — test harness in both repos. Three PRs.
10. IDEA-05 — split `web/src/services/index.tsx`. Six sequential PRs.
    Do this **before** IDEA-12's logger swap and any web feature work,
    so subsequent PRs touch one domain module instead of the 2275-line
    monolith.
11. IDEA-06 — split `DashboardSettings.tsx`. Two PRs.

**Sprint 3 — observability + audit:**

12. IDEA-12 — logger + Sentry. Four PRs across both repos.
13. IDEA-24 — generalised audit log. Two PRs.

**Sprint 4 — security feature:**

14. IDEA-23 — TOTP 2FA. Three PRs. Depends on IDEA-12 (PR 2 of 23 wants
    Sentry visibility for failed-verification rate).
15. IDEA-25 — CSP report-to endpoint. Tiny; pair with IDEA-12.

**Sprint 5+ — backlog at intent:**

16. IDEA-21 (mobile polish), IDEA-19 (skeletons), IDEA-20 (axe-core),
    IDEA-14 (HTTP/3 verify), IDEA-31 (clips RSS), IDEA-29 (templates if
    deferred), IDEA-30 (OpenAPI — long; can start partial), IDEA-28
    (Renovate, only after IDEA-03 is fully drained), IDEA-13 (image
    pipeline), IDEA-32 (FTS).

**P3 deferred** unless explicitly prioritised: IDEA-11, IDEA-18,
IDEA-22, IDEA-33, IDEA-28 (until value over Dependabot is clear).

**IDEAs blocked on a CONCEPT.md decision** (flagged inline above):
IDEA-02 (Node version), IDEA-09 (which sub-feature to ship), IDEA-13
(storage backend), IDEA-23 (encryption-at-rest reuse), IDEA-32 (FTS
language dictionary). Each section above marks the decision and shows
the conditional plan.
