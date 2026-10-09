# ANDX Web2 assessment kit

Requires Node 20 or newer. No dependencies. Read `ANDX-Web2-Assessment.md` first; this file is only the command reference.

## gen

```bash
node generator/andx-gen.js gen --preset small|medium|full --seed N --out DIR [--gzip]
```

Writes `events.ndjson` (or `events.ndjson.gz` with `--gzip`), `campaigns.json`, `campaigns-late.json` and `manifest.json` to `DIR`. The output is identical for the same preset and seed.

| Preset | Lines | Size | Time (Apple M-series) |
|---|---|---|---|
| small | ~455K | 93 MB raw | ~2 s |
| medium | ~3.4M | 139 MB gzipped | ~20 s |
| full | ~22.8M | 0.95 GB gzipped, ~4.7 GB raw | ~2 min, peak memory ~1.6 GB |

## send

```bash
node generator/andx-gen.js send --data DIR [--url http://localhost:8080] [--rate 15000] \
  [--burst-mult 10] [--burst-at 0.5] [--burst-secs 60] [--no-burst] \
  [--batch 5000] [--concurrency 8] [--slice START:END] [--file NAME]
```

POSTs NDJSON batches to `URL/v1/events`. Retries a batch on timeouts (30 s), network errors and 5xx. Honours `Retry-After` on 429 and 503. Stops on any other 4xx. Prints progress every 5 seconds.

## check

```bash
node generator/andx-gen.js check --api http://localhost:8081 --expected expected/small-seed7.json [--phase final|before_replay] [--perf]
```

Compares your API with an expected-answers file:

- `--phase before_replay` checks only `/v1/stats`, after the main stream and before the late campaigns are registered.
- `--phase final` (the default) checks stats, spend for every campaign, earnings for a sample of creators, and top-clips for sample windows (two pages each, through `next_cursor`). It runs after `campaigns-late.json` is registered and the DLQ is replayed.
- `--perf` adds sequential p95 latency measurements.

The full flow for the small preset:

```bash
node generator/andx-gen.js gen --preset small --seed 7 --out ./data-small
curl -XPOST localhost:8081/v1/admin/campaigns -H 'content-type: application/json' --data-binary @data-small/campaigns.json
node generator/andx-gen.js send --data ./data-small
node generator/andx-gen.js check --expected expected/small-seed7.json --phase before_replay
curl -XPOST localhost:8081/v1/admin/campaigns -H 'content-type: application/json' --data-binary @data-small/campaigns-late.json
curl -XPOST localhost:8081/v1/dlq/replay -H 'content-type: application/json' -d '{"reason":"unknown_campaign"}'
node generator/andx-gen.js check --expected expected/small-seed7.json --perf
```

Wait for your system to finish processing before each `check`.
