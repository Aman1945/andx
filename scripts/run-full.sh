#!/usr/bin/env bash
# Full preset at the assessment's settings. Records P1/P2 timings and samples spend <= budget during the run.
set -uo pipefail
cd "$(dirname "$0")/.."
GEN=web2-kit/generator/andx-gen.js
DATA=${DATA:-./data-full}
OUT=${OUT:-./full-run.log}
backlog() { docker compose exec -T broker redis-cli eval "return redis.call('XLEN','ingest.views')+redis.call('XLEN','clip.changes')+redis.call('XLEN','commands')" 0; }

docker compose down -v >/dev/null 2>&1; docker compose up -d >/dev/null 2>&1; sleep 15
curl -s -XPOST localhost:8081/v1/admin/campaigns -H 'content-type: application/json' --data-binary @"$DATA/campaigns.json" >/dev/null
CAMPS=$(python3 -c "import json;print(' '.join(c['campaign_id'] for c in json.load(open('$DATA/campaigns.json'))[:200]))")

( while true; do
    for c in $CAMPS; do
      r=$(curl -s "localhost:8081/v1/campaigns/$c/spend")
      python3 -c "import json,sys;d=json.loads(sys.argv[1]);sys.exit(0 if d['spend_cents']<=d['budget_cents'] else 1)" "$r" || echo "OVERSPEND $r" >> "$OUT"
    done
    sleep 5
  done ) & SAMPLER=$!

START=$(date +%s)
echo "start $(date)" > "$OUT"
node $GEN send --data "$DATA" --rate 20000 --burst-mult 10 --burst-secs 60 --burst-at 0.5 >> "$OUT" 2>&1
SENT=$(date +%s)
until [ "$(backlog)" = "0" ]; do sleep 2; done
DONE=$(date +%s)
kill $SAMPLER 2>/dev/null
echo "P1 first request -> processed: $((DONE-START))s; P2 drain after sender finished: $((DONE-SENT))s" >> "$OUT"
curl -s localhost:8081/v1/stats >> "$OUT"; echo >> "$OUT"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' >> "$OUT"
echo "restarts: $(docker compose ps -a --format '{{.Service}}={{.Status}}' | tr '\n' ' ')" >> "$OUT"
echo FINISHED >> "$OUT"
