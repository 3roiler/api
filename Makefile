.PHONY: help pg-start pg-stop pg-logs pg-shell migrate-up migrate-down migrate-create build run start stop

help: ## Zeigt diese Hilfe an
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# Postgres
pg-start: ## PostgreSQL und pgAdmin starten
	docker compose up -d postgres pgadmin

pg-stop: ## PostgreSQL und pgAdmin stoppen
	docker compose down postgres pgadmin

pg-logs: ## PostgreSQL Logs anzeigen
	docker compose logs -f postgres

pg-shell: ## PostgreSQL Shell öffnen
	docker compose exec postgres psql -U postgres -d api_db
# Migrations
migrate-up: ## Alle ausstehenden Migrationen ausführen
	npm run migrate:up

migrate-down: ## Letzte Migration zurückrollen
	npm run migrate:down

migrate-create: ## Neue Migration erstellen (usage: make migrate-create name=add_products)
	npm run migrate:create -- $(name)

# Node.js Befehle
compile: ## TypeScript kompilieren
	npm run build

# Docker Compose Befehle
build: ## Docker Images bauen 
	docker compose build

run: ## Server mit Docker Compose starten (terminal gebunden)
	docker compose up postgres -d
	make migrate-up
	docker compose up

start: ## Server mit Docker Compose im Hintergrund starten
	docker compose up -d
	make migrate-up

stop: ## Server stoppen
	docker compose down