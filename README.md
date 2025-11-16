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

## 5. Docker Image bauen

Multi-Stage Docker Build (kleines Production Image). Beispiel lokal:

```bash
docker build -t api:local .
docker run --env-file .env -p 3000:3000 api:local
```
