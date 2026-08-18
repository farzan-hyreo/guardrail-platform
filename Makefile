# SOT: makefile, cli, runbook-commands
# One-word commands for the things you do every day. `make help` lists them.
.DEFAULT_GOAL := help
.PHONY: help up down dev web services logs streams subjects migrate verify fix reset

help: ## Show this list
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## Start NATS + Postgres, then create the JetStream streams
	pnpm infra:up && sleep 3 && pnpm nats:bootstrap

down: ## Stop the local stack
	pnpm infra:down

dev: ## Run the web gateway and every service together
	pnpm dev

web: ## Run only the Next.js gateway + UI
	pnpm dev:web

services: ## Run only the service workers
	pnpm dev:services

logs: ## Tail every event crossing the bus
	nats sub 'evt.>' --server $${NATS_URL:-localhost:4222}

streams: ## Show stream and consumer health
	nats stream report --server $${NATS_URL:-localhost:4222}

subjects: ## Print every subject the registry generates
	pnpm subjects

migrate: ## Run every service's migrations
	pnpm db:generate && pnpm db:migrate

verify: ## Typecheck, Biome check, and the architecture check
	pnpm verify

fix: ## Format, autofix lint, and repair architecture violations
	pnpm check:fix && pnpm guardrail:fix

reset: ## Wipe local data and start clean
	pnpm infra:down && docker volume rm guardrail_nats-data guardrail_pg-data || true
