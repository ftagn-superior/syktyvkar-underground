.DEFAULT_GOAL := run

PNPM ?= npx --yes pnpm@12.18.0

.PHONY: run install build start

run: build
	$(PNPM) start

install:
	$(PNPM) install --frozen-lockfile

build:
	$(PNPM) build

start:
	$(PNPM) start
