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
.PHONY: help bootstrap doctor env-status clean-check up down down-all nuke deps test test-unit test-all check check-docs conformance acceptance acceptance-ui browser browser-deps web cli adapters bench runner helm dc-runtime site land local local-status local-down local-destroy

help: ## Show this help
	@echo "ADP test environment"
	@echo
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'
	@echo

bootstrap: ## Provision a bare Debian/Ubuntu machine to run the suite (needs root/sudo)
	@bash scripts/dev/bootstrap.sh

doctor: ## Preflight: is this machine able to run the suite?
	@bash scripts/dev/doctor.sh

env-status: ## Report the health of the adp-dev environment
	@bash scripts/dev/env-status.sh $(ARGS)

clean-check: ## Assert no state leaked from a previous run
	@bash scripts/dev/verify-clean.sh

up: ## Bring up the ephemeral dependency stack, write .env.test
	@bash scripts/dev/up.sh

down: ## Tear down this checkout's stack and verify it is gone
	@bash scripts/dev/down.sh

down-all: ## Tear down every adp-test-* stack on this machine
	@bash scripts/dev/down.sh --all

deps: ## Install node dependencies (server, web, cli, adapters, and runner)
	npm ci --prefix server
	npm ci --prefix server/web
	npm ci --prefix cli
	npm ci --prefix adapters
	npm ci --prefix runner

test-unit: ## Unit + integration tiers only (no database needed)
	npm test --prefix server

test: ## Full suite with the e2e tier enforced (needs 'make up')
	$(REQUIRE_ENV)
	@$(LOAD_ENV) npm run typecheck --prefix server
	@$(LOAD_ENV) npm test --prefix server

conformance: ## The gh gate: real, unmodified gh against a live server
	$(REQUIRE_ENV)
	@$(LOAD_ENV) bash server/conformance/run.sh

acceptance: ## The §2.1 definition-of-done walkthrough (docs/manual-test-plan.md)
	$(REQUIRE_ENV)
	@$(LOAD_ENV) bash server/acceptance/run.sh

acceptance-ui: ## ...including the web UI, driven by a real browser
	$(REQUIRE_ENV)
	@$(MAKE) web
	@$(MAKE) browser
	@$(LOAD_ENV) ADP_ACCEPTANCE_UI=1 bash server/acceptance/run.sh

browser: ## Download the pinned Chromium build Playwright drives
	@if [ -x "$${ADP_CHROMIUM_PATH:-}" ]; then \
		echo "using ADP_CHROMIUM_PATH=$$ADP_CHROMIUM_PATH — skipping the pinned download"; \
	else \
		npx --prefix server playwright install chromium; \
	fi

browser-deps: ## Install Chromium's system libraries (needs root)
	npx --prefix server playwright install-deps chromium

web: ## Typecheck, build, and test the supervision UI
	npm run typecheck --prefix server/web
	npm run build --prefix server/web
	npm test --prefix server/web

cli: ## Typecheck, build, and test the adp CLI (no database needed)
	npm run typecheck --prefix cli
	npm run build --prefix cli
	npm test --prefix cli

adapters: ## Test the scanner-as-gate adapters (no database needed)
	npm test --prefix adapters

runner: ## Typecheck, build, and test the gate runner (no database, REAL docker required)
	npm run typecheck --prefix runner
	npm run build --prefix runner
	# ADP_REQUIRE_DOCKER=1 (#99): without it, a machine where the docker
	# daemon is down runs this target green while silently skipping the
	# real-container isolation tier — the exact skip-looks-like-a-pass
	# failure AGENTS.md's standing invariant exists to prevent, on the one
	# package whose entire job is container isolation. This box runs the
	# distro docker.io daemon; if this fails with "docker unreachable",
	# start it, don't unset the flag.
	ADP_REQUIRE_DOCKER=1 npm test --prefix runner

helm: ## Lint and render the self-host chart (skipped if helm is absent; ADP_REQUIRE_HELM=1 makes that fatal)
	@bash scripts/dev/helm-check.sh

dc-runtime: ## Rebuild the published site's runtime from dc-runtime/src and assert it is unchanged
	npm ci --prefix dc-runtime
	npm run typecheck --prefix dc-runtime
	npm run check --prefix dc-runtime

site: ## Assert the published pages meet #163's exit criteria, in a real browser
	npm ci --prefix dc-runtime
	@# The browser comes from dc-runtime's own Playwright, not from `make browser`
	@# (which uses server/): this test must run without server's dependency tree
	@# installed, since nothing it touches needs a database or a server. Like
	@# `make acceptance-ui`, it deliberately does not install system libraries —
	@# that needs root, and the workflow does it in its own step.
	@if [ -x "$${ADP_CHROMIUM_PATH:-}" ]; then \
		echo "using ADP_CHROMIUM_PATH=$$ADP_CHROMIUM_PATH — skipping the pinned download"; \
	else \
		npx --prefix dc-runtime playwright install chromium; \
	fi
	npm test --prefix dc-runtime

bench: ## Regenerate the benchmark report from bench/runs/ and assert it is unchanged
	npm run report --prefix bench
	@git diff --exit-code bench/report/ || { \
		echo "bench/report/ is stale — commit the regenerated report"; exit 1; }

test-all: ## Everything CI runs: build, full suite, web, cli, adapters, runner, chart, conformance + acceptance
	$(REQUIRE_ENV)
	@$(LOAD_ENV) npm run typecheck --prefix server
	@$(LOAD_ENV) npm run build --prefix server
	@$(LOAD_ENV) npm run migrate --prefix server
	@$(LOAD_ENV) npm test --prefix server
	@$(MAKE) web
	@$(MAKE) cli
	@$(MAKE) adapters
	@$(MAKE) runner
	@$(MAKE) helm
	@$(MAKE) bench
	@$(MAKE) dc-runtime
	@$(MAKE) site
	@$(LOAD_ENV) bash server/conformance/run.sh
	@$(LOAD_ENV) bash server/acceptance/run.sh

check-docs: ## Assert tracked docs still point at real paths, links and issue states
	@bash scripts/check-docs.sh

check-release: ## Assert the version surfaces agree: spec, chart, packages, CHANGELOG, tag
	@bash scripts/dev/check-release.sh

demo: ## The test drive: land a change and read its signed evidence, then tear down
	@bash scripts/dev/demo.sh

local: ## A persistent local instance with a certificate gh will accept
	@bash scripts/dev/local.sh up

local-status: ## Is the local instance up, and on what
	@bash scripts/dev/local.sh status

local-down: ## Stop the local instance, keeping its data
	@bash scripts/dev/local.sh down

local-destroy: ## Stop the local instance and delete its data
	@bash scripts/dev/local.sh destroy

check-branch: ## Assert the current branch is named feat/, fix/ or docs/ (no-op on main)
	@bash scripts/dev/check-branch.sh

land: ## Merge a PR (PR=n), keeping its branch when another open PR is stacked on it
	@bash scripts/dev/land.sh $(PR)

check: ## The gate. Same target name in every repo in this line of work.
	@$(MAKE) check-branch
	@$(MAKE) check-docs
	@$(MAKE) check-release
	@$(MAKE) test-all

nuke: ## Full teardown: every stack, all generated files, deps and caches
	-@bash scripts/dev/down.sh --all
	-@bash scripts/dev/verify-clean.sh --fix
	rm -rf server/node_modules server/dist server/web/node_modules server/web/dist cli/node_modules cli/dist adapters/node_modules runner/node_modules runner/dist
	rm -rf $(ENV_FILE) .adp-test
	rm -rf $${GH_CACHE_DIR:-$$HOME/.cache/adp-conformance-gh}
	@echo "nuked — 'make deps && make up' to start over"
