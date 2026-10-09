# ANDX Clip View Pipeline

**Hours spent:** about 4.5 hours of wall-clock time on 9 Oct (first commit 16:41 IST), most of it running and tuning the full preset. Most code was written with Claude Code; see AI_USAGE.md.
**Unfinished / known gaps:**
- P1 is met but not "strong": the full preset took **31 min** from first request to fully processed (target < 45 min, strong < 20 min). The single aggregator is the limit; see Known limitations.
- The classifier's LLM path is implemented but **not measured**: no model key was configured, so the rule layer is what ran. See EVAL.md.
- The full preset has no expected file in the kit, so full-run correctness was checked only for internal consistency (stats before and after replay add up). Exact correctness was checked on small (official expected file) and on medium (an independent reference, `scripts/reference.ts`).

---

## How to run

Requirements: Docker (10 GB memory, 6 CPUs), `make`, Node 20+ on the host for the kit's generator. Leave plenty of free disk for the full preset (Postgres data, up to 8 GB of WAL, the Redis AOF): three full runs grew my Colima disk image to ~37 GB, and when the host disk filled, Docker failed with I/O errors; `docker compose down -v` frees it, and on Colima `colima ssh -- sudo fstrim -av` returns it to the host.

```bash
docker compose up -d --build          # gateway :8080, api :8081, plus aggregator, earnings, classifier, broker, postgres
make test                             # unit tests, inside Docker
make small                            # the full small-preset flow from web2-kit/README.md, ends with the checker
scripts/chaos.sh aggregator 120 10    # fresh stack, SIGKILL a service mid-stream, keep it down, restart, check
scripts/run-full.sh                   # full preset at 20k/s with a 60 s 10x burst; writes full-run.log
```

Optional hosted model for the classifier (OpenAI-compatible): set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` in the shell before `docker compose up`. Without them the classifier runs its rule layer only.

## Architecture

```
                 POST /v1/events (NDJSON)
 sender ───────────────► gateway :8080 ──validate every line──┐
                          │  lag-driven 429/503                │ one MULTI per request
                          ▼                                    ▼
                ┌──────────────────── broker (Redis Streams, AOF fsync always) ─────────────────────┐
                │ ingest.views  (snapshots + invalid lines)   ingest.text (clip_text)                │
                │ clip.changes  (V(clip,end_at) changes)      commands    (DLQ replay)               │
                └───────┬───────────────────────┬──────────────────────┬─────────────────▲──────────┘
                        │                       │                      │                 │
                        ▼                       ▼                      ▼                 │
                   aggregator ──outbox──► clip.changes ──────► earnings             classifier
                   schema agg                                   schema earn          schema cls
                        ▲ reads api.campaigns                    ▲ reads api.campaigns
                        │                                        │
                   ┌────┴────────────────── Postgres (one schema per service) ───────────────┐
                   │ api (catalog)   agg (snapshots, dedup, DLQ, stats)   earn (results)   cls │
                   └───────────────────────────────▲──────────────────────────────────────────┘
                                                   │ reads all schemas, writes only api
                                              api :8081  ──XADD commands──► broker
```

| Service | Owns | Reads | Publishes | Consumes |
|---|---|---|---|---|
| gateway | nothing in Postgres | – | `ingest.views`, `ingest.text` | – |
| aggregator | `agg.*` | `api.campaigns` | `clip.changes` (via outbox) | `ingest.views`, `commands` |
| earnings | `earn.*` | `api.campaigns` | – | `clip.changes` |
| api | `api.campaigns` | all schemas (read only) | `commands` | – |
| classifier | `cls.relevance` | – | – | `ingest.text` |

No service calls another over HTTP. All five services share one Docker image (Node 24 runs the TypeScript directly) with a different entrypoint each.

## Broker choice and why

**Redis Streams**, with `appendonly yes` and `appendfsync always`.

- Consumer groups give at-least-once delivery with per-consumer pending lists, which is exactly what restart-and-resume needs, and `XLEN` is a direct, cheap lag signal for backpressure.
- The gateway writes one stream entry per HTTP request (up to 10k lines), so fsync-per-write costs one fsync per request, not per line. `MULTI/EXEC` makes the views and clip_text entries of one request atomic.
- Consumers `XACK` + `XDEL` after committing, so the stream only holds unprocessed work and memory stays bounded. `maxmemory 1800mb` with `noeviction` means Redis refuses writes rather than dropping data; the gateway turns that into a 503.

**What it can lose, and when.** With `appendfsync always`, an acknowledged write survives a Redis crash or a graceful restart. It can lose data if the disk under the AOF is lost (single node, no replica), and an AOF truncated by a power cut at the exact moment of a write loses that one unacknowledged request, which the sender retries. It does not replicate, so it is not highly available: while Redis is down the gateway answers 503.

## Internal event contracts (all JSON in stream field `m`, all versioned)

| Stream | `type` | `v` | Body |
|---|---|---|---|
| `ingest.views` | `ingest_batch` | 1 | `views: [[event_id_hex, clip, campaign, creator, observed_ms, emitted_ms, views], ...]`, `invalid: [[identity, raw_line], ...]` (ids are the numeric part of `c_`/`k_`/`u_`) |
| `ingest.text` | `clip_text_batch` | 1 | `items: [[event_id_hex, clip, campaign, caption, transcript], ...]` |
| `clip.changes` | `clip_v_end_changed` | 1 | `items: [[rev, clip, campaign, creator, v_end], ...]`; `rev` is the aggregator outbox id, strictly increasing per clip |
| `commands` | `dlq_replay` | 1 | `reason`, `requested_at` |

Consumers skip (and log) any message whose `v`/`type` they do not understand, so a newer producer cannot crash an older consumer.

## Data model, partitioning and indexes

Ids are stored as integers (their patterns are fixed and validated) to keep rows and indexes small.

**agg (aggregator)**
- `seen_events(event_id bigint PK, outcome)`: dedup ledger of every distinct accepted (`A`) or late (`L`) snapshot. The 64-bit event id fits a `bigint` exactly.
- `snapshots(clip_id, observed_ms, views)`, **hash-partitioned by clip_id into 8 partitions**, primary key `(clip_id, observed_ms) INCLUDE (views)`. V(clip, t) is one backward index-only probe. Partitioning keeps each partition's index and visibility map small for vacuum and lets probes for one clip touch one partition.
- `clips(clip_id PK, campaign_id, creator_id)` with `(campaign_id, clip_id) INCLUDE (creator_id)` for top-clips.
- `clip_state(clip_id PK, v_end_obs, v_end)`: V(clip, end_at) as of the newest observation before the campaign end.
- `dlq(reason, identity, payload)` PK `(reason, identity)`; identity is the event id, or `h:`+SHA-256 for unparseable lines.
- `outbox(id bigserial, clip_id, campaign_id, creator_id, v_end)`.
- `stats(...)`: counters updated in the same transaction as the rows they count, so `/v1/stats` is a single-row read.

**earn (earnings)**: `clip_values(clip_id PK, campaign_id, creator_id, v_end, rev)` (inputs), `campaign_spend(campaign_id PK, ...)` and `creator_campaign((creator_id, campaign_id) PK, clips, earned_cents)` (outputs). `creator_campaign`'s primary key serves creator earnings directly.

**api**: `campaigns(campaign_id PK, ...)`. **cls**: `relevance(clip_id PK, ...)`.

## Exactly-once effects

Delivery is at-least-once everywhere; effects are made exactly-once by idempotency keys and by committing state and progress together.

- **gateway**: stateless. A retried request is a duplicate delivery, which the aggregator absorbs.
- **aggregator**: each batch (up to 8 stream entries, ~40k lines) is one Postgres transaction: `INSERT ... ON CONFLICT DO NOTHING RETURNING` on `seen_events` decides which events are new; only those touch `snapshots`, `clip_state`, the DLQ, the counters and the outbox. Stream entries are acked after commit. A crash before commit rolls back; a crash after commit but before the ack re-delivers a batch whose events are all already in `seen_events`, so nothing changes.
- **outbox**: `clip_state` changes and their outbox rows commit together. A relay publishes outbox rows to `clip.changes` and then deletes them; a crash in between republishes, and earnings ignores any item whose `rev` is not newer than what it has.
- **earnings**: applies items in memory, then flushes one transaction that writes the inputs (`clip_values` with `rev`) and the outputs (spend, creator rows) together, and only then acks the entries it covered. If the flush fails it exits and rebuilds from Postgres plus the still-pending entries.
- **DLQ replay**: replayed events go through the same code path, so an event already accepted is a no-op, one still unknown stays (`ON CONFLICT DO NOTHING`), and one now accepted leaves the DLQ in the same transaction.

## What happens when each service dies mid-batch

| Service | Effect | Recovery |
|---|---|---|
| gateway | In-flight requests fail with a network error, the sender retries them. A request whose MULTI landed before the crash is delivered twice and deduplicated. | Stateless; health check passes as soon as Redis is reachable. |
| aggregator | Open transaction rolls back. Its entries stay pending in Redis. The gateway sees `ingest.views` grow and answers 429. | On start it re-reads its own pending entries first, relays any committed-but-unpublished outbox rows, then continues. |
| earnings | Unflushed in-memory work is lost; its entries are still pending. Spend and earnings stay at the last flush (frozen) while ingestion continues. | On start it reloads `earn.*`, re-reads pending entries, skips items with old `rev`, and catches up to exact values. |
| api | Requests fail while it is down. A campaign upsert either committed (and is visible) or did not (and the caller saw no 200). | Stateless apart from Postgres. |
| classifier | Pending clip_text entries are re-delivered; results are upserts by clip_id. | Same as above. |

Verified by `scripts/chaos.sh` for gateway, aggregator, earnings and api (results below).

## Backpressure thresholds

The gateway polls the broker every 200 ms and decides from **lag**, not from request rate:

- `XLEN ingest.views` is the number of unprocessed requests (consumers delete what they have acked). Above **60 entries** (~300k lines at 5k lines/request) it answers **429** with `Retry-After: 1`, and keeps doing so until the backlog drains below **30** (hysteresis, so it does not flap).
- `XLEN ingest.text` above 200 entries, or Redis `used_memory` above 1.3 GB (of 1.8 GB `maxmemory`), also throttles.
- If Redis is unreachable, the lag reading is older than 2 s, or the write is not acknowledged within 5 s, it answers **503** with `Retry-After`.

60 entries is about 15 to 25 seconds of aggregator work at the measured 12k to 20k lines/s: enough to absorb the start of a burst without throttling, small enough that Redis memory for the backlog stays around 100 MB.

## EXPLAIN (ANALYZE, BUFFERS) for top-clips, full dataset

Largest campaign in the full run (`k_00006`, 9,540 clips), 168-hour window (the maximum), first page (`limit` 50, one extra row to detect the next page), warm cache, `jit=off`. Full output: [docs/explain-top-clips.txt](docs/explain-top-clips.txt). Summary:

```
Limit (actual time=~55 ms, rows=51)
  CTE gained (MATERIALIZED)
    -> Index Only Scan using clips_by_campaign on clips c   (rows=9540)   Index Cond: campaign_id = 6
       SubPlan 1: Limit -> Merge Append -> Index Only Scan Backward using snapshots_pN_pkey   V(clip, to)
       SubPlan 2: Limit -> Merge Append -> Index Only Scan Backward using snapshots_pN_pkey   V(clip, from)
       (run-time partition pruning: each probe runs on the clip's one hash partition; loops sum to 9,540)
  -> Sort (top-N heapsort) on views_gained DESC, clip_id
Buffers: shared hit ~62k, read 0.   Execution Time: 55.5 ms
```

Each clip costs two backward index-only probes, one per bound, so the cost grows with clips in the campaign, not with snapshots. Two changes came from reading this plan: the CTE is `MATERIALIZED`, because inlined, Postgres ran both probes twice (once for `views_gained > 0`, once for the select list: 122k buffer hits and 342 ms before, 62k and ~55 ms after); and `jit=off`, because JIT compilation alone took 63 ms on this query.

## Measured performance

All on one laptop: Apple Silicon, Colima VM with 6 CPUs and 10 GB, every container at the limits in `docker-compose.yml`.

**Full preset** (seed 1, 22,773,952 lines, 11,456 malformed), `scripts/run-full.sh`: `--rate 20000 --burst-mult 10 --burst-secs 60 --burst-at 0.5`.

| Criterion | Result | Target |
|---|---|---|
| P1: first request to everything processed | **1,859 s (31 min)** | < 45 min (strong < 20 min) |
| P2: backlog drained after the sender finished | **16 s** | < 5 min |
| P3: gateway during the run | A probe POSTed one already-delivered line every second for the whole run: 804 × 202, 967 × 429, 1 × 503, **slowest answer 1.5 s**. Sender: 7,614 throttled requests, 0 network retries. | every answer within 10 s |
| P3: restarts / OOM | **0 restarts**. Memory at the end: postgres 2.3 GiB / 4 GiB, earnings 420 MiB, aggregator 151 MiB, gateway 113 MiB, api 40 MiB, classifier 29 MiB, broker 8 MiB | no restarts, no OOM |
| Spend never above budget | Sampled every ~5 s for the first 200 campaigns during the run: **0 violations** | always |

Sender throughput: 12,358 lines/s on average. The aggregator ran at ~16 to 20k lines/s at first and settled at ~12 to 13k lines/s as the tables grew; the gateway throttled with 429 whenever the backlog crossed 60 entries.

Stats after the main stream: `distinct_valid_events` 22,113,533, `late_dropped` 89,526, `invalid_schema` 11,456, `unknown_campaign` 222,529. After registering `campaigns-late.json` and replaying (settled in 12 s): `distinct_valid_events` 22,336,062 (= 22,113,533 + 222,529), `unknown_campaign` 0.

**P4** (full data, kit checker `--perf`, sequential requests; the checker has no expected file for full, so I fed it a file of real query targets: all 2,020 campaigns, 300 creators, and 20 top-clips queries on the 10 largest campaigns with 168 h and 24 h windows):

| Endpoint | p95 | Target |
|---|---|---|
| top-clips | **50.8 ms** | ≤ 500 ms |
| spend | **0.8 ms** | ≤ 100 ms |
| creator earnings | **0.7 ms** | ≤ 150 ms |
| stats | **0.6 ms** | ≤ 200 ms |

**Correctness**
- Small (seed 7, official expected file): **272 / 272** checks.
- Medium (seed 1): **609 / 609** checks (stats in both phases, spend for all 308 campaigns, earnings for 300 creators) against `expected-medium.json`, which `scripts/reference.ts` computes independently in one process, with no broker or database. It was validated first by reproducing the official small expected file exactly.

**What tuning changed** (each measured on the full preset):
1. Earnings flushed whenever it was caught up, which under load meant every ~1.5 s, rewriting ~27k creator rows each time and saturating Postgres. Now it flushes on a timer that grows with flush cost (0.5 s idle, up to 15 s under load).
2. `fillfactor = 70` on the three tables updated in place (`clip_state`, `clip_values`, `creator_campaign`), so over 90% of updates were HOT (92 to 98% in the full run's `pg_stat_user_tables`) and skip index writes.
3. The aggregator deleted from the DLQ for every accepted event while any unknown-campaign event was pending (40k index probes per batch). It now does so only for campaigns that have had DLQ entries.
4. `shared_buffers` 1 GB to 2 GB (the dedup index alone reached ~900 MB), and autovacuum off for the insert-only `seen_events`.

Before (2) to (4), the aggregator had fallen to ~5k lines/s by 13M lines, and that run was stopped because it would not have finished within 45 minutes.

## Failure tests run

As the spec describes: medium preset (seed 1, 3,417,151 lines), sent at `--rate 20000` with a 10× burst; the service is `SIGKILL`ed 52 s in (during the burst), kept down for 120 s, then started again, each on a fresh stack (`DATA=./data-medium EXPECTED=./expected-medium.json scripts/chaos.sh <service> 120 52`). Afterwards: before-replay stats check, register `campaigns-late.json`, DLQ replay, full check against the independent reference.

| Killed | Sender result | before_replay | final (stats, 308 spends, 300 creators) |
|---|---|---|---|
| gateway | finished in 284 s, 224 network retries while it was down | 1 / 1 | **609 / 609** |
| aggregator | finished in 436 s, 979 throttled (backlog grew while it was down), 256 retries | 1 / 1 | **609 / 609** |
| earnings | finished in 149 s, ingestion unaffected | 1 / 1 | **609 / 609** |
| api | finished in 146 s, ingestion unaffected | 1 / 1 | **609 / 609** |

Also run earlier in development, on the small preset against the official expected file (272 / 272 each): the same four `SIGKILL`s, a Redis restart mid-stream (services reconnect, no loss), sending the whole file twice (idempotent), and hostile lines (go to the `invalid_schema` DLQ). After the full run, Postgres and every service were restarted once on the finished data (to apply `jit=off`); the checker afterwards read the same values (2,341 / 2,341 against the values captured before the restart).

## AI: clip relevance

See [EVAL.md](EVAL.md). The classifier runs a deterministic rule layer (brief violations R1/R2 and brand detection, including speech-to-text misspellings and Devanagari) and, when `LLM_*` is set, asks the model only about the remaining judgement calls (main subject, sentiment). Model: none was configured for the measured runs, so the rule layer (`rules-v1`) produced every result. Set `LLM_*` to switch the judgement step to a hosted model (`rules+<LLM_MODEL>`).

## Assumptions

- **Malformed identity namespace**: a malformed line's identity (its `event_id` or its hash) is unique among malformed lines only. A malformed line that reuses a valid event's `event_id` does not prevent that valid event from being accepted.
- **"JSON integer"**: a number that is a safe integer after parsing (`10`, `10.0` and `1e1` all count); `1.5`, strings, and values beyond 2^53 do not.
- **Line and body limits**: 10,000 non-empty lines and 8 MiB (8,388,608 bytes); either is answered with 413.
- **Caption/transcript length** is counted in Unicode code points.
- **`rejected`** in the 202 response counts malformed lines in the request, including identical ones.
- **Unknown creator ids** that are malformed (not `u_` + 6 digits) return 200 with zero earnings; malformed campaign ids return 404 like unregistered ones.
- **Creator `total_cents`** is the sum of the per-campaign rows earnings wrote; api adds them, it does not recompute any payout.
- **DLQ replay of `invalid_schema`** is accepted and changes nothing, as specified.

## Known limitations

- **Throughput is capped by one aggregator.** One consumer applies each batch in one transaction: about 30k `clip_state` upserts (~25 µs each), plus `seen_events` and `snapshots` inserts per 40k lines. That gave 12 to 20k lines/s here, so the full preset took 31 min. The next steps are in DESIGN.md: partition `ingest.views` by clip and run one aggregator per partition (a clip's state never crosses partitions), and keep V(clip, end_at) in memory per partition instead of upserting it per batch.
- **Earnings recomputes every dirty campaign on each flush**, and writes one row per changed creator: ~200k rows per flush under load (5 to 14 s). It is correct and bounded, but for a campaign with millions of clips it would need incremental totals and a sorted structure for the over-budget split.
- **Spend and earnings lag ingestion** by up to one flush interval under load (≤ 15 s plus the flush itself). They are exact once the backlog drains.
- **`seen_events` grows forever** (~900 MB at 22M events). In production it would be partitioned by time and old partitions dropped once duplicates can no longer arrive (the spec says up to 20 minutes apart).
- **Single Redis node.** Durable with `appendfsync always`, but not highly available: while it is down the gateway answers 503.
- **One 503** in the full run's gateway probe (1 of 1,772 requests): I did not capture its cause. The gateway answers 503 only when Redis is not ready, the last lag poll failed or is older than 2 s, or the write fails or times out; the request took 2 ms, so it was most likely a failed or stale lag poll. It is a valid backpressure answer, but the lag poll should be made more robust.
- The classifier is measured only on the 44-row dev set, in-sample for the rule layer (EVAL.md).
