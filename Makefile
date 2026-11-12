.DEFAULT_GOAL := run

PNPM ?= npx --yes pnpm@12.18.0
FILE ?= output/map-layout.json
PATCH ?= output/map-layout.patch.json

.PHONY: run install build start map-export map-patch map-check map-apply

run: build
	$(PNPM) db:migrate:built
	$(PNPM) world:migrate:built
	$(PNPM) start

install:
	$(PNPM) install --frozen-lockfile

build:
	$(PNPM) build

start:
	$(PNPM) start

# Run `make build` first. Only map-patch works without a database or stopped world.
map-export:
	$(PNPM) world:layout:export:built --file "$(FILE)"

map-patch:
	@test -n "$(BASE)" -a -n "$(EDITED)" || { echo 'Use make map-patch BASE=<export.json> EDITED=<edited.json> [PATCH=<patch.json>]' >&2; exit 1; }
	$(PNPM) world:layout:patch:built --base "$(BASE)" --edited "$(EDITED)" --file "$(PATCH)"

map-check:
	$(PNPM) world:layout:apply:built --file "$(PATCH)" --dry-run

map-apply:
	$(PNPM) world:layout:apply:built --file "$(PATCH)"
