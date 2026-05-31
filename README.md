# api.broiler.dev – Node.js, TypeScript & PostgreSQL

Backend für [broiler.dev](https://broiler.dev). Liefert die API für das
Frontend unter [`3roiler/web`](https://github.com/3roiler/web) (User, Blog,
Streamclips, 3D-Printer-Tooling, Admin/Dashboard, OG-Renderer, Sitemap, RSS).

Stack:

- TypeScript -> Node.js 26 -> Express 5
- PostgreSQL 18 als persistenter Speicher (via `pg` + `node-pg-migrate`)
- Redis 8 als Cache (u. a. Metrics-Proxy, OAuth-State)
- Saubere Layer (Routes -> Controller -> Service)
- Health Check, strukturiertes Logging, scoped Rate-Limits
- CSRF (Double-Submit-Cookie), Whitelist-CORS, JWT-Cookie-Auth
- Docker Multi-Stage Build, optimiert für DigitalOcean Deployment

## Inhaltsverzeichnis

1. Projektstruktur
2. Schnellstart
3. API Endpoints
4. Entwicklung & Scripts
5. Datenbank & Migrations
6. Docker
7. Feature-Highlights

## 1. Projektstruktur

```text
src/
├── app.ts              # Express App, CORS, Rate-Limits, CSRF, Server-Bootstrap
├── controllers/        # Request-Handler (Validierung, Status-Codes, Mapping)
├── services/           # Geschäftslogik, DB-Zugriffe, externe APIs
├── routes/             # Routing-Komposition pro Domäne
├── middleware/         # csrf, requirePermission
└── models/             # Geteilte TypeScript-Typen

migrations/             # node-pg-migrate Files (JS, timestamped)
.devcontainer/          # VS Code Dev Container (Node 26 + Docker-in-Docker)
.github/workflows/      # CI/CD (Docker-Build)
Dockerfile              # Multi-Stage Build (builder -> runner, non-root)
docker-compose.yml      # postgres + redis + pgadmin (dev profile) + api
Makefile                # Convenience-Wrapper um docker compose + npm scripts
```

Domänen-Snapshot (services + zugehörige Routen):

- `auth`, `oauth-state`, `crypto`, `permissions`, `group`, `user`, `bootstrap`
- `blog`
- `clip`, `clip-rating`, `clip-report`, `twitch-clip`, `twitch-category`,
  `award-category`, `foryou-settings`, `comment`
- `printer`, `print-job`, `print-request`, `gcode`, `stl`, `asset-store`,
  `file-helpers`
- `settings` (verschlüsselter Secret-Store), `metrics` (DigitalOcean-Proxy)
- `system` (Login/Register/Logout, Auth-Middleware, Errorhandler), `logger`,
  `persistence`, `config`, `error`

## 2. Schnellstart

### Voraussetzungen

- Visual Studio Code (aktuelle Version)
- VS Code Erweiterung: Dev Containers
- Docker Engine (oder Docker Desktop) läuft
- Git

Kurzer Check:

```bash
code --version
docker info >/dev/null && echo "Docker OK"
git --version
```

### Variante A — Dev Container (empfohlen)

Repo öffnen, **Reopen in Container** wählen. Der Container basiert auf
`mcr.microsoft.com/devcontainers/typescript-node:26` mit Docker-in-Docker;
`npm install` läuft automatisch als `postStartCommand`.

### Variante B — lokal mit Docker Compose

```bash
cp .env.example .env       # Twitch-Credentials, PG_PASSWORD usw. eintragen
make start                 # postgres + redis + api hochfahren, Migrationen ausführen
```

Wichtigste Env-Variablen (siehe `.env.example` + `docker-compose.yml`):
`NODE_ENV`, `HOST`, `PORT`, `API_PREFIX`, `DATABASE_URL`, `REDIS_URL`,
`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`. In Produktion zusätzlich:
`JWT_SECRET`, `CORS_ORIGIN`, `ADMIN_EMAILS`, `SECRETS_KEY` (AES-256-GCM).
GitHub-OAuth-Secrets und der DigitalOcean-PAT werden zur Laufzeit über
`/api/admin/settings/secrets` gepflegt — nicht via Env.

Health Check prüfen:

```bash
curl http://localhost:3000/api/health
```

## 3. API Endpoints

Alle Routen liegen unter `API_PREFIX` (default `/api`). Auth läuft per
HttpOnly-Cookie (JWT, siehe `services/auth.ts`); mutierende Calls brauchen
zusätzlich das per `GET /api/csrf` ausgegebene Token im
`X-CSRF-Token`-Header (siehe `middleware/csrf.ts`).

Gruppiert nach Domäne — vollständige Liste in `src/routes/`.

- **System** — `GET /`, `GET /health`, `GET /csrf`,
  `GET /sitemap.xml`, `GET /blog/rss.xml`,
  `GET /og/streamclips/clip/:id`, `GET /og/blog/:slug`
- **Auth** — `POST /login`, `POST /register`, `POST /logout`,
  `GET|POST /twitch/oauth(-state)`, `GET|POST /github/oauth(-state)`,
  `GET /twitch/me`, `GET /twitch/stream/:channel`, `POST /twitch/chat/send`
- **Users (self-service)** — `GET /user/me`, `PUT /user/me`,
  `GET /user/me/export` (DSGVO), `POST /user/nuke` (Anonymisierung),
  `GET /user/search`
- **Comments** (Clip + Blog teilen das Datenmodell) —
  `GET|POST /clips/:id/comments`, `GET|POST /blog/:slug/comments`,
  `DELETE /comments/:id`, `PATCH /comments/:id/moderate|restore`
- **Streamclips (public)** — `GET /clips/leaderboard|browse|search|contributors`,
  `GET /clips/by-broadcaster/:broadcasterId`, `GET /clips/:id`,
  `GET /categories/awards|sections`
- **Streamclips (auth)** — `GET /clips/feed/next`, `GET /clips/feed/foryou`,
  `GET /clips/mine`, `POST /clips` (Einreichen, `clips.submit`),
  `POST /clips/:id/rating`, `POST /clips/:id/report`
- **Blog** — `GET /blog`, `GET /blog/:slug` (sichtbarkeit: public / auth /
  group), Schreib-Routen erfordern `blog.write`
- **3D-Drucker** — `/printer`, `/printer/:id/jobs/*`, `/print-request/*`
  (Permissions: `print.request`, `print.moderate`, plus per-printer-ACL),
  `/gcode`, `/stl` (Upload via `application/octet-stream`)
- **Agent** — `/agent/*` authentifiziert per `X-Agent-Token` (printer-scoped,
  **nicht** per User-JWT). Heartbeat, Job-Transitions, G-Code-Download
- **Admin** — alles unter `/admin` ist gegated:
  - Users + Groups + Permissions (`admin.manage`)
  - `/admin/dashboard-stats` (`dashboard.view`)
  - `/admin/settings/*` (`dashboard.settings`, inkl. verschlüsseltem
    Secret-Store)
  - `/admin/metrics/*` (`dashboard.metrics`, DigitalOcean-Apps + DB)
  - `/admin/streamclips/*` (`clips.moderate`, inkl. Bulk-Moderation,
    Reports, Awards, „Für dich"-Tuning, Comment-Mutes)

Rate-Limits werden in `app.ts` scoped vergeben: Login/Register, OAuth,
OAuth-State, Twitch-Stream, DSGVO-Export, global (100/10 min) und ein
eigener, großzügigerer Bucket für `/admin/metrics/*`.

## 4. Entwicklung & Scripts

| Script | Zweck |
| --- | --- |
| `npm run dev` | `tsx watch src/app.ts` — Hot-Reload |
| `npm run build` | TypeScript → `dist/` |
| `npm start` | `node dist/app.js` (Produktionsmodus) |
| `npm run lint` | ESLint über `.ts` |
| `npm run lint:fix` | ESLint Auto-Fix |
| `npm run migrate:create -- <name>` | Neue Migration anlegen |
| `npm run migrate:up` | Ausstehende Migrationen ausführen |
| `npm run migrate:down` | Letzte Migration zurückrollen |
| `npm run migrate:redo` | `down` + `up` (lokales Iterieren) |

Make-Targets (`make help` zeigt alle):

| Target | Zweck |
| --- | --- |
| `make pg-start` / `pg-stop` / `pg-logs` / `pg-shell` | Lokale Postgres-Lifecycle (+ pgAdmin) |
| `make migrate-up` / `migrate-down` / `migrate-create name=…` | Wrapper um die npm-Migrationsskripte |
| `make compile` | `npm run build` |
| `make build` | `docker compose build` |
| `make run` | Postgres + Migrationen + `docker compose up` (foreground) |
| `make start` | dasselbe im Detached-Modus |
| `make stop` | `docker compose down` |

## 5. Datenbank & Migrations

Migrationen liegen in `/migrations` und werden von
[`node-pg-migrate`](https://github.com/salsita/node-pg-migrate) ausgeführt.
Konfiguration: `.pgmigraterc.json` (SSL erzwungen, Database-URL aus
`DATABASE_URL`, Tabelle `pgmigrations`). Dateiformat:
`<timestamp>_<seq>_<name>.js`.

Neue Migration anlegen:

```bash
npm run migrate:create -- add_something
# oder
make migrate-create name=add_something
```

Beim Container-Start ruft `docker-entrypoint.sh` automatisch
`migrate:up` auf, bevor die App startet.

## 6. Docker

```bash
make build          # Multi-Stage Build (builder -> non-root runner)
docker compose up   # postgres + redis + api
docker compose --profile dev up pgadmin
```

Das Image läuft als unprivilegierter User (`nodeusr`), exponiert `PORT`
(default 3000) und bringt einen `HEALTHCHECK` gegen `${API_PREFIX}/health`
mit. `.env` wird zur Laufzeit eingespielt (steht in `.dockerignore`, landet
also nicht im Image).

## 7. Feature-Highlights

Größere Bausteine aus den letzten ~50 Merges (Stand: 2026-05):

- **Streamclips Germany** — Twitch-Clip-Rating-Plattform: Einreichen,
  Moderations-Queue (inkl. Bulk-Aktionen), Awards, Reports, Leaderboards,
  „Mehr von diesem Streamer"-Karussell, personalisierter „Für dich"-Feed
  mit tunbaren Gewichten, Contributor-Statistiken, öffentliche Clip-Detail-
  und OG-Seiten.
- **Comments** — beliebig tief verschachtelt, Clip + Blog teilen denselben
  Endpunkt-Satz, Soft-Delete mit Mod-Restore + Audit-Trail, 30 s-Cooldown
  (Mods bypassen), User-Mutes mit Begründung + Ablaufdatum.
- **User-Lifecycle** — Profil-Selfservice (Avatar-Sync, Social-Links),
  DSGVO-Datenexport (`/user/me/export`, eigener Rate-Limit-Bucket),
  Anonymisierung (`/user/nuke`, transaktional).
- **Admin & Dashboard** — paginierte/suchbare User-Liste, Limit/Offset
  auf Moderation-Queue + Reports, granulare Permissions (`admin.manage`,
  `dashboard.*`, `blog.write`, `clips.*`, `print.*`), Gruppen mit
  vererbbaren Rechten.
- **Settings & Secrets** — verschlüsselter Secret-Store (AES-256-GCM)
  hinter `/admin/settings/secrets`, plus DigitalOcean-Metrics-Proxy
  (App + DB) mit Redis-Cache und eigenem Rate-Limit.
- **3D-Drucker** — Drucker + G-Code + STL + Print-Requests, per-printer-
  ACL, Operator-Genehmigungsflow, Agent-API (`X-Agent-Token`) für
  Heartbeat/Job-Transitions/Progress/Events.
- **Blog** — Sichtbarkeit pro Post (public / authenticated / group),
  dynamischer RSS-2.0-Feed unter `/blog/rss.xml`.
- **Discovery für Crawler** — server-renderte Open-Graph-Tags (Caddy leitet
  Social-Bots nach `/og/...` um), dynamische `sitemap.xml` (Hubs + Clips
  + Posts).
- **Security-Hardening** — JWT-Revocation, OAuth-State-Cookies (CSRF-fest),
  CSRF Double-Submit-Cookie, Whitelist-CORS mit Dev-Fallback, IDOR-Audit,
  scoped Rate-Limits.

Lizenz: MIT (siehe `package.json`).
