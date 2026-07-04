# Colors for help output (ANSI escape codes)
CYAN := \033[36m
YELLOW := \033[33m
RESET := \033[0m

ENV_CHECK = if [ ! -f .env ]; then cp .env.example .env; echo ".env created. Edit it before running Docker"; else echo ".env already exists, not overwritten"; fi

all: up ## Alias for 'up' (default target)

up: ## Start containers in detached mode
	@$(ENV_CHECK) && docker compose up -d

dev: ## Start containers in foreground (dev mode, logs attached)
	@$(ENV_CHECK) && docker compose up

wasm: ## Rebuild frontend (WASM) and restart detached
	@$(ENV_CHECK) && docker compose build frontend && docker compose up -d

wasm-full: ## Rebuild frontend from scratch (no cache) and restart detached
	@$(ENV_CHECK) && docker compose build --no-cache frontend && docker compose up -d

down: ## Stop and remove containers (keeps volumes/images)
	docker compose down

# Rebuild frontend (WASM + browser JS) and nginx, restart backend to pick up
# mounted src changes — covers all JS changes without a full wasm recompile.
re: down ## Rebuild frontend+nginx, restart backend (fast JS-only cycle)
	@$(ENV_CHECK) && docker compose build frontend nginx && docker compose up -d
	@docker compose restart backend

build: ## Build all images without starting containers
	@$(ENV_CHECK) && docker compose build

logs: ## Follow logs for all services
	docker compose logs -f

logs-%: ## Follow logs for one service, e.g. make logs-backend
	docker compose logs -f $*

clean: ## Remove containers + volumes, prune dangling system resources
	docker compose down -v
	docker system prune -a -f

destroy: ## Nuke this project: containers, volumes, images, orphans
	docker compose down --volumes --remove-orphans --rmi all || true
	@if [ -n "$$(docker ps -aq)" ]; then docker stop $$(docker ps -aq); fi
	@if [ -n "$$(docker ps -aq)" ]; then docker rm -f $$(docker ps -aq); fi
	@if [ -n "$$(docker images -aq)" ]; then docker rmi -f $$(docker images -aq); fi
	@if [ -n "$$(docker volume ls -q)" ]; then docker volume rm $$(docker volume ls -q); fi
	docker builder prune -a -f || true
	docker buildx prune -a -f || true
	docker system prune -a --volumes -f || true

delete: destroy ## Alias for destroy

shell-%: ## Open a shell in a running container, e.g. make shell-backend
	docker compose exec $* sh

help: ## Show this help message
	@echo "$(YELLOW)Available commands:$(RESET)"
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_%-]+:.*##/ { printf "  $(CYAN)%-15s$(RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: all up down dev build logs clean destroy delete re shell-% wasm wasm-full help
