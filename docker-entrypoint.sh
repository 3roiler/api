#!/bin/sh
set -e

echo "[entrypoint] Running database migrations (SSL-aware wrapper)..."
node -e "import('./dist/scripts/migrate.js').then(module => module.run())"

echo "[entrypoint] Starting API server..."
exec node dist/app.js