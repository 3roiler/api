# api.broiler.dev – Node.js, TypeScript & PostgreSQL

Ein modernes, erweiterbares API Backend mit:

- TypeScript
- Express
- PostgreSQL
- Sauberen Layern (Routes / Controller / Service / Config / Middleware)
- Health Check & strukturiertes Logging
- Docker Multi-Stage Build & DigitalOcean Deployment

## Inhaltsverzeichnis

1. Projektstruktur
2. Schnellstart
3. API Endpoints
4. Entwicklung & Scripts
5. Docker Image bauen

## 1. Projektstruktur

```text
src/
├── app.ts              # Express App & Server Setup
├── config/             # Konfiguration (env + DB)
├── controllers/        # Request Handler
├── middleware/         # Logging / Errors / 404
├── models/             # Data models
├── routes/             # Routing Komposition
└── services/           # Geschäftslogik

Dockerfile              # Multi-Stage Build
.do/app.yaml            # DigitalOcean App Platform Spec
.github/workflows/      # CI/CD Workflows
```

## 2. Schnellstart

### Voraussetzungen

Stelle sicher, dass lokal folgendes bereitsteht:

- Visual Studio Code (aktuelle Version)
- VS Code Erweiterung: Dev Containers
- Docker Engine (oder Docker Desktop) läuft
- Git installiert

Kurzer Check:

```bash
code --version
docker info >/dev/null && echo "Docker OK"
git --version
```

### Mit Docker Compose (empfohlen)

```bash
cp .env.example .env            # DB-Konfiguration
make start-all
```

Health Check prüfen:

```bash
curl http://localhost:3000/api/v1/health
```

## OAuth & Redirects

Die OAuth-Implementierung ist provider-agnostisch aufgebaut. Jeder Provider liefert seine Einstellungen (Scope, Redirects, Allow-List, State-Lebensdauer) über die zentrale Config aus. Aktuell ist GitHub aktiviert – weitere Provider lassen sich hinzufügen, indem man eine neue Strategy registriert und in der Config einträgt.

- Aufruf: `GET /api/<prefix>/auth/<provider>?redirect=<URL>` speichert die gewünschte Zieladresse (nach Validierung) zusammen mit einem zufälligen `state` in der Session.
- Erlaubte Redirect-Origins: `GITHUB_REDIRECT_ALLOW_LIST` (kommasepariert). Standardmäßig werden zusätzlich `GITHUB_DEFAULT_REDIRECT`, `GITHUB_SUCCESS_REDIRECT` und die API-Basisadresse whitelisted.
- Optionaler Fallback: `GITHUB_DEFAULT_REDIRECT` (sonst `GITHUB_SUCCESS_REDIRECT`). Relative Ziele (`/dashboard`) werden nur akzeptiert, wenn eine Default-Origin existiert.
- State: Ablauf via `GITHUB_STATE_MAX_AGE_MS` (Default 5 Minuten). Nach Rückkehr von GitHub wird der State konsumiert, verifiziert und anschließend verworfen.
- Antwort: Erfolgreiche Logins leiten auf `<redirect>?token=<JWT>` weiter oder liefern JSON `{ token, user, groups, scopes, redirect }`.

### CORS

Credential-basierte Requests (Cookies) erfordern explizit freigegebene Origins. Nutze `CORS_ALLOWED_ORIGINS` (kommasepariert), um Frontend-Domains zu hinterlegen. Die OAuth-Redirect-Origins werden automatisch mit aufgenommen. Für lokale Entwicklung empfiehlt sich z. B. `http://localhost:3000`.

- Über `CORS_ALLOW_CREDENTIALS` lässt sich steuern, ob Auth-Cookies ausgeliefert werden (Standard: `true`).

### Linting

`npm run lint` prüft den Code-Stil via ESLint (Flat Config, TypeScript-aware). Bei neuen Providern unbedingt passende Tests hinzufügen und den Lint-Job lokal ausführen.

## 5. Docker Image bauen

Multi-Stage Docker Build (kleines Production Image). Beispiel lokal:

```bash
docker build -t api:local .
docker run --env-file .env -p 3000:3000 api:local
```
