.PHONY: install dev build start serve typecheck check clean

install:
	bun install

dev:
	bun run dev

build:
	bun run build

start:
	bun run start

serve:
	bun run serve

typecheck:
	bun run typecheck

check:
	bun run check

clean:
	bun run clean
