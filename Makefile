.PHONY: test up down reset small eval

# Unit tests run inside Docker: only docker and make are needed on the host.
test:
	docker build -q -t andx-pipeline:latest . >/dev/null
	docker run --rm andx-pipeline:latest node --test "tests/*.test.ts"

up:
	docker compose up -d --build

down:
	docker compose down

# Wipe all state (Postgres + broker volumes).
reset:
	docker compose down -v

# Full small-preset flow from web2-kit/README.md.
small:
	./scripts/run-small.sh

eval:
	docker run --rm -e LLM_BASE_URL -e LLM_API_KEY -e LLM_MODEL andx-pipeline:latest node scripts/eval-classifier.ts
