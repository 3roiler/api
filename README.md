# api.broiler.dev – Node.js, TypeScript & PostgreSQL

Ein modernes, erweiterbares API Backend mit:

- TypeScript -> Node.js -> Express
- PostgreSQL als persistenten Speicher
- Redis als Cache & Session-Store
- Sauberen Layern (Routes -> Controller -> Service -> Config)
- Health Check & strukturiertes Logging
- Docker Multi-Stage Build & Optimiert auf DgitalOcean Deployment

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
├── controllers/        # Request Handler
├── models/             # Data models
├── routes/             # Routing Komposition
└── services/           # Geschäftslogik

Dockerfile              # Multi-Stage Build
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

### Umgebungskonfigurationen anpassen

```bash
cp .env.example .env
make start-all
```

Health Check prüfen:

```bash
curl http://localhost:3000/api/health
```

## 5. Docker Images bauen

```bash
make build
```
