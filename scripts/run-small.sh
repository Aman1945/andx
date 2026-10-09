#!/usr/bin/env bash
# The small-preset flow from web2-kit/README.md, with waits for processing to finish.
set -euo pipefail
cd "$(dirname "$0")/.."
GEN=web2-kit/generator/andx-gen.js
DATA=${DATA:-./data-small}
EXPECTED=${EXPECTED:-web2-kit/expected/small-seed7.json}
SEED=${SEED:-7}

[ -f "$DATA/events.ndjson" ] || node $GEN gen --preset small --seed "$SEED" --out "$DATA"

wait_idle() {
  # Waits until the broker streams are drained and the stats stop changing.
  local prev="" cur
  for _ in $(seq 1 600); do
    local backlog
    backlog=$(docker compose exec -T broker redis-cli eval "return redis.call('XLEN','ingest.views')+redis.call('XLEN','clip.changes')+redis.call('XLEN','commands')" 0)
    cur=$(curl -s localhost:8081/v1/stats)
    if [ "$backlog" = "0" ] && [ "$cur" = "$prev" ]; then sleep 2; return; fi
    prev=$cur
    sleep 2
  done
  echo "timed out waiting for idle" >&2
}

curl -s -XPOST localhost:8081/v1/admin/campaigns -H 'content-type: application/json' --data-binary @"$DATA/campaigns.json"; echo
time node $GEN send --data "$DATA"
wait_idle
node $GEN check --expected "$EXPECTED" --phase before_replay
curl -s -XPOST localhost:8081/v1/admin/campaigns -H 'content-type: application/json' --data-binary @"$DATA/campaigns-late.json"; echo
curl -s -XPOST localhost:8081/v1/dlq/replay -H 'content-type: application/json' -d '{"reason":"unknown_campaign"}'; echo
wait_idle
node $GEN check --expected "$EXPECTED" --perf
