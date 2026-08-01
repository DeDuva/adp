# One entrypoint for the test environment — see docs/test-environment-automation.md.
#
# CI does not call these targets yet: it runs its own step list against a
# Postgres service container rather than this compose stack. Converging the two
# is Phase 2. Until then `test-all` deliberately mirrors CI's step order, so
# drift between them is at least visible.
#
# Typical loop:
#   make doctor    # can this machine run the suite at all?
#   make up        # ephemeral Postgres on a discovered port, writes .env.test
#   make test      # full suite, e2e tier enforced (not silently skipped)
#   make down      # tear down, then assert nothing leaked

SHELL := /usr/bin/env bash
ENV_FILE := .env.test

# Load .env.test into the recipe's environment. Recipes run one shell per line,
# so this has to be inlined into each command rather than set once at the top.
LOAD_ENV = set -a; . ./$(ENV_FILE); set +a;
REQUIRE_ENV = @test -f $(ENV_FILE) || { \
	echo "no $(ENV_FILE) — run 'make up' first (or 'bash scripts/dev/env.sh <DSN>')"; \
	exit 1; }

.DEFAULT_GOAL := help
.PHONY: help doctor clean-check up down down-all nuke deps test test-unit test-all conformance web

help: ## Show this help
	@echo "ADP test environment"
	@echo
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'
	@echo

doctor: ## Preflight: is this machine able to run the suite?
	@bash scripts/dev/doctor.sh

clean-check: ## Assert no state leaked from a previous run
	@bash scripts/dev/verify-clean.sh

up: ## Bring up the ephemeral dependency stack, write .env.test
	@bash scripts/dev/up.sh

down: ## Tear down this checkout's stack and verify it is gone
	@bash scripts/dev/down.sh

down-all: ## Tear down every adp-test-* stack on this machine
	@bash scripts/dev/down.sh --all

deps: ## Install node dependencies (server and web)
	npm ci --prefix server
	npm ci --prefix server/web

test-unit: ## Unit + integration tiers only (no database needed)
	npm test --prefix server

test: ## Full suite with the e2e tier enforced (needs 'make up')
	$(REQUIRE_ENV)
	@$(LOAD_ENV) npm run typecheck --prefix server
	@$(LOAD_ENV) npm test --prefix server

conformance: ## The gh gate: real, unmodified gh against a live server
	$(REQUIRE_ENV)
	@$(LOAD_ENV) bash server/conformance/run.sh

web: ## Typecheck and build the supervision UI
	npm run typecheck --prefix server/web
	npm run build --prefix server/web

test-all: ## Everything CI runs: build, full suite, web, conformance gate
	$(REQUIRE_ENV)
	@$(LOAD_ENV) npm run typecheck --prefix server
	@$(LOAD_ENV) npm run build --prefix server
	@$(LOAD_ENV) npm run migrate --prefix server
	@$(LOAD_ENV) npm test --prefix server
	@$(MAKE) web
	@$(LOAD_ENV) bash server/conformance/run.sh

nuke: ## Full teardown: every stack, all generated files, deps and caches
	-@bash scripts/dev/down.sh --all
	-@bash scripts/dev/verify-clean.sh --fix
	rm -rf server/node_modules server/dist server/web/node_modules server/web/dist
	rm -rf $(ENV_FILE) .adp-test
	rm -rf $${GH_CACHE_DIR:-$$HOME/.cache/adp-conformance-gh}
	@echo "nuked — 'make deps && make up' to start over"
