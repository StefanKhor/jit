.PHONY: install dev build start serve typecheck check clean

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

start:
	npm start

serve:
	npm run serve

typecheck:
	npm run typecheck

check:
	npm run check

clean:
	npm run clean
