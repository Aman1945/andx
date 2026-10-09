#!/usr/bin/env bash
# Crash test: fresh stack, start sending, SIGKILL one service mid-stream, keep it down, restart,
# finish the late-campaign flow, then compare every number with the expected file.
# Usage: scripts/chaos.sh <service> [down_seconds] [kill_after_seconds]
set -euo pipefail
cd "$(dirname "$0")/.."
SVC=$1; DOWN=${2:-30}; AFTER=${3:-6}
GEN=web2-kit/generator/andx-gen.js
DATA=${DATA:-./data-small}
EXPECTED=${EXPECTED:-web2-kit/expected/small-seed7.json}

backlog() { docker compose exec -T broker redis-cli eval "return redis.call('XLEN','ingest.views')+redis.call('XLEN','clip.changes')+redis.call('XLEN','commands')" 0; }
wait_idle() { local p="" c; for _ in $(seq 1 900); do c=$(curl -s localhost:8081/v1/stats || true); if [ "$(backlog)" = "0" ] && [ -n "$c" ] && [ "$c" = "$p" ]; then return; fi; p=$c; sleep 2; done; }
wait_healthy() { for _ in $(seq 1 120); do curl -sf localhost:8080/healthz >/dev/null && curl -sf localhost:8081/healthz >/dev/null && return; sleep 1; done; }

docker compose down -v >/dev/null 2>&1
docker compose up -d >/dev/null 2>&1
wait_healthy
curl -s -XPOST localhost:8081/v1/admin/campaigns -H 'content-type: application/json' --data-binary @"$DATA/campaigns.json" >/dev/null
node $GEN send --data "$DATA" --rate 20000 --burst-mult 10 --burst-at 0.3 --burst-secs 10 > /tmp/andx-send.log 2>&1 &
SENDER=$!
sleep "$AFTER"
echo "SIGKILL $SVC"; docker compose kill -s SIGKILL "$SVC" >/dev/null
docker compose stop "$SVC" >/dev/null 2>&1 || true
sleep "$DOWN"
echo "start $SVC"; docker compose start "$SVC" >/dev/null
wait $SENDER; tail -1 /tmp/andx-send.log
wait_healthy; wait_idle
node $GEN check --expected "$EXPECTED" --phase before_replay | tail -1
curl -s -XPOST localhost:8081/v1/admin/campaigns -H 'content-type: application/json' --data-binary @"$DATA/campaigns-late.json" >/dev/null
curl -s -XPOST localhost:8081/v1/dlq/replay -H 'content-type: application/json' -d '{"reason":"unknown_campaign"}' >/dev/null
wait_idle
node $GEN check --expected "$EXPECTED" | tail -1
