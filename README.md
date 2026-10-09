# ANDX Clip View Pipeline

**Hours spent:** ~__HOURS__ (see AI_USAGE.md for how AI tools were used).
**Unfinished / known gaps:** __UNFINISHED__

---

## How to run

Requirements: Docker (10 GB memory, 6 CPUs), `make`, Node 20+ on the host for the kit's generator.

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

60 entries is about 10 to 15 seconds of aggregator work: enough to absorb the start of a burst without throttling, small enough that Redis memory for the backlog stays around 100 MB.

## EXPLAIN (ANALYZE, BUFFERS) for top-clips, full dataset

__EXPLAIN__

## Measured performance

__PERF__

## Failure tests run

__CHAOS__

## AI: clip relevance

See [EVAL.md](EVAL.md). The classifier runs a deterministic rule layer (brief violations R1/R2 and brand detection, including speech-to-text misspellings and Devanagari) and, when `LLM_*` is set, asks the model only about the remaining judgement calls (main subject, sentiment). Model: __MODEL__.

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

__LIMITS__
