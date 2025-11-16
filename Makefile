.PHONY: help install dev build start clean db-up db-down db-restart migrate-up migrate-down migrate-create logs test

help: ## Zeigt diese Hilfe an
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Dependencies installieren
	npm install

dev: ## Dev-Server starten (Hot-Reload)
	npm run dev

build: ## TypeScript kompilieren
	npm run build

start: ## Production Server starten
	npm start

clean: ## Build-Artefakte löschen
	rm -rf dist node_modules

# Docker Compose Befehle
db-up: ## PostgreSQL Container starten
	docker compose up -d postgres

db-down: ## PostgreSQL Container stoppen
	docker compose down

db-restart: ## PostgreSQL Container neu starten
	docker compose restart postgres

db-logs: ## PostgreSQL Logs anzeigen
	docker compose logs -f postgres

db-shell: ## PostgreSQL Shell öffnen
	docker compose exec postgres psql -U postgres -d gateway_db

db-reset: ## Datenbank zurücksetzen (VORSICHT: Löscht alle Daten!)
	docker compose down -v
	docker compose up -d postgres
	sleep 5
	npm run migrate:up

# pgAdmin
pgadmin-up: ## pgAdmin Container starten
	docker compose up -d pgadmin

pgadmin-down: ## pgAdmin Container stoppen
	docker compose stop pgadmin

# Migrations
migrate-up: ## Alle ausstehenden Migrationen ausführen
	npm run migrate:up

migrate-down: ## Letzte Migration zurückrollen
	npm run migrate:down

migrate-create: ## Neue Migration erstellen (usage: make migrate-create name=add_products)
	npm run migrate:create -- $(name)

# Full Stack
start-all: db-up pgadmin-up migrate-up dev ## Startet PostgreSQL, pgAdmin, führt Migrationen aus und startet API

stop-all: ## Stoppt alle Services
	docker compose down
