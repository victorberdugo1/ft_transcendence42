ENV_CHECK = if [ ! -f .env ]; then cp .env.example .env; echo ".env created. Edit it before running Docker"; else echo ".env already exists, not overwritten"; fi

all: up

up:
	@$(ENV_CHECK) && docker compose up -d

dev:
	@$(ENV_CHECK) && docker compose up

wasm:
	@$(ENV_CHECK) && docker compose build frontend && docker compose up -d

wasm-full:
	@$(ENV_CHECK) && docker compose build --no-cache frontend && docker compose up -d

down:
	docker compose down

# Rebuild frontend (WASM + browser JS) and nginx, restart backend to pick up
# mounted src changes — covers all JS changes without a full wasm recompile.
re: down
	@$(ENV_CHECK) && docker compose build frontend nginx && docker compose up -d
	@docker compose restart backend

build:
	@$(ENV_CHECK) && docker compose build

logs:
	docker compose logs -f

logs-%:
	docker compose logs -f $*

clean:
	docker compose down -v
	docker system prune -a -f

destroy:
	docker compose down --volumes --remove-orphans --rmi all || true
	@if [ -n "$$(docker ps -aq)" ]; then docker stop $$(docker ps -aq); fi
	@if [ -n "$$(docker ps -aq)" ]; then docker rm -f $$(docker ps -aq); fi
	@if [ -n "$$(docker images -aq)" ]; then docker rmi -f $$(docker images -aq); fi
	@if [ -n "$$(docker volume ls -q)" ]; then docker volume rm $$(docker volume ls -q); fi
	docker builder prune -a -f || true
	docker buildx prune -a -f || true
	docker system prune -a --volumes -f || true

delete: destroy

shell-%:
	docker compose exec $* sh

.PHONY: all up down dev build logs clean destroy delete re shell-% wasm wasm-full