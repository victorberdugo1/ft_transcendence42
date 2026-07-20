# Colors for help output (ANSI escape codes)
CYAN := \033[36m
YELLOW := \033[33m
RESET := \033[0m

ENV_CHECK = if [ ! -f .env ]; then cp .env.example .env; echo ".env created. Edit it before running Docker"; else echo ".env already exists, not overwritten"; fi

DEV_COMPOSE := docker-compose.dev.yml
GAME_BUILDER_IMAGE := ft_transcendence42-game-builder:dev

all: up ## Alias for 'up' (default target)

up: ## Start containers in detached mode
	@$(ENV_CHECK) && docker compose up -d

dev-assets: ## Build/extract game.js, game.wasm, game.data into frontend/dist and frontend/app/public for Vite dev
	@mkdir -p frontend/dist frontend/app/public
	@docker build -f frontend/Dockerfile --target game-builder -t $(GAME_BUILDER_IMAGE) frontend
	@cid=$$(docker create $(GAME_BUILDER_IMAGE)); \
		docker cp $$cid:/build/game.js frontend/dist/game.js; \
		docker cp $$cid:/build/game.wasm frontend/dist/game.wasm; \
		docker cp $$cid:/build/game.data frontend/dist/game.data; \
		docker cp $$cid:/build/game.js frontend/app/public/game.js; \
		docker cp $$cid:/build/game.wasm frontend/app/public/game.wasm; \
		docker cp $$cid:/build/game.data frontend/app/public/game.data; \
		docker rm $$cid >/dev/null

dev: dev-assets ## Start dev stack from docker-compose.dev.yml (hot-reload, foreground)
	@$(ENV_CHECK) && docker compose -f $(DEV_COMPOSE) up

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

# NOTE: 'clean'/'destroy' are scoped to THIS project's compose resources only
# (docker compose down ...). They deliberately avoid `docker system/builder
# prune` and unfiltered `docker ps/images/volume ls` — those operate on the
# entire Docker daemon and would delete containers/images/volumes belonging
# to other, unrelated projects on the same machine.
clean: ## Remove this project's containers, volumes and networks
	docker compose down --volumes --remove-orphans

destroy: ## Nuke this project only: its containers, volumes, images and orphans
	docker compose down --volumes --remove-orphans --rmi all || true

delete: destroy ## Alias for destroy

shell-%: ## Open a shell in a running container, e.g. make shell-backend
	docker compose exec $* sh

help: ## Show this help message
	@echo "$(YELLOW)Available commands:$(RESET)"
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_%-]+:.*##/ { printf "  $(CYAN)%-15s$(RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: all up down dev dev-assets build logs clean destroy delete re shell-% wasm wasm-full help
