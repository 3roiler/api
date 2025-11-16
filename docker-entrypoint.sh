#!/bin/sh
set -e

echo "[entrypoint] Starting API server..."
exec node dist/app.js