# ANDX Engineering Assessment (Web2): Clip View Pipeline

| | |
|---|---|
| **What you build** | A small event-driven system of microservices that ingests about 22.8 million clip view events, turns them into correct earnings for creators, and answers queries on that data quickly. A small AI service classifies clips against campaign briefs. |
| **Expected effort** | **14 to 18 focused hours.** The 48 hours is the window, not the expected effort. If you reach 20 hours, stop and list what is unfinished at the top of your README. |
| **Deadline** | 48 hours from when you receive this document. |
| **What makes it hard** | Correctness at volume and under failure. The rules are exact, and we check your numbers against ground truth after killing your services, restarting your broker, replaying traffic and injecting bad data. |
| **What you get** | `web2-kit/`: a deterministic data generator, a load sender, a checker, expected answers for a small dataset, and the AI dev set. |
| **Languages** | Each service in **TypeScript (Node or Bun) or Python**, your choice per service. Every other requirement is the same either way. |

---

## 1. Context

ANDX runs clipping campaigns. A brand funds a campaign with a budget and a rate per 1,000 views (CPM). Creators post short clips for the campaign. Pollers check each clip's view count on the social platforms and emit **view snapshots**: "clip X had N views at time T". Creators are paid from those snapshots.

In production this is hundreds of millions of snapshots a day, delivered at least once, out of order, sometimes late, sometimes malformed. Money depends on getting every one of them right. This assessment is a scaled-down, self-contained version of that pipeline.

---

## 2. The kit

```
web2-kit/
  generator/andx-gen.js        gen, send and check commands (Node 20+, no dependencies)
  expected/small-seed7.json    expected answers for: gen --preset small --seed 7
  ai/briefs.json               three campaign briefs for the classifier
  ai/labeling-rules.md         how clips are labelled on-brief or not
  ai/dev.jsonl                 44 labelled clips (the hidden test set has 120 more)
  README.md                    command reference, including the full small-preset flow
```

### 2.1 Generate data

```bash
node generator/andx-gen.js gen --preset small  --seed 7 --out ./data-small          # 455K lines,  93 MB, ~2 s
node generator/andx-gen.js gen --preset medium --seed 1 --out ./data-medium --gzip  # 3.4M lines, 139 MB, ~20 s
node generator/andx-gen.js gen --preset full   --seed 1 --out ./data-full   --gzip  # 22.8M lines, 0.95 GB gzipped (4.7 GB raw), ~2 min
```

Each output folder contains `events.ndjson` (or `.ndjson.gz`), `campaigns.json`, `campaigns-late.json` and `manifest.json`.

| Preset | Clips | Creators | Campaigns in `campaigns.json` | Campaigns only in `campaigns-late.json` | Lines |
|---|---|---|---|---|---|
| small | 20,000 | 4,000 | 40 | 2 | ~455K |
| medium | 150,000 | 30,000 | 300 | 8 | ~3.4M |
| full | 1,000,000 | 200,000 | 2,000 | 20 | ~22.8M |

The output is fully determined by `(preset, seed)`. We test with seeds you have not seen.

**Plan your time around volume.** A full run takes 20 to 45 minutes of wall-clock time. Iterate on small and medium, and run the full preset when you are confident (at least once before you submit).

### 2.2 Send data to your system

```bash
node generator/andx-gen.js send --data ./data-full --url http://localhost:8080 \
     --rate 20000 --burst-mult 10 --burst-secs 60 --burst-at 0.5
```

How the sender behaves, so you can design for it:

- It reads the file in order and POSTs batches of 5,000 lines (`--batch`), with up to 8 requests in flight (`--concurrency`).
- It offers `--rate` lines per second. When it reaches `--burst-at` of the file, it offers `rate × burst-mult` (200,000 lines/s with the settings above) for `--burst-secs`.
  - The sender itself sustains about 200,000 lines/s against a gateway that answers each request in under 200 ms.
  - The rate your system actually receives during the burst is bounded by how fast your gateway answers, and by any 429 or 503 you return.
- On a timeout (30 s), a network error or any 5xx other than 503, it **retries the same batch**. So the same line can reach you more than once, and a batch you already stored can arrive again.
- On 429 or 503 it waits for `Retry-After` seconds (default 1) and retries.
- On any other 4xx it stops with an error.
- `--slice START:END` sends only those line numbers (0-based). `--file NAME` sends another file from the same folder. `--no-burst` disables the burst.

### 2.3 Check your answers

```bash
node generator/andx-gen.js check --api http://localhost:8081 --expected expected/small-seed7.json [--phase before_replay] [--perf]
```

It calls your API (section 6) and compares the results with the expected file. Field order and extra fields in your responses do not matter. `--perf` also prints p95 latencies. We use this same checker, with expected files computed from our hidden seeds. The full small-preset flow is in `web2-kit/README.md`.

---

## 3. The data

### 3.1 Events

Every line in the stream is one JSON object, or garbage. There are two schema versions of the view snapshot event, plus one text event used by the AI service.

**View snapshot, schema v1**

```json
{"v":1,"event_id":"7c5424d0e71521d4","clip_id":"c_0010277","campaign_id":"k_00015","creator_id":"u_000814","observed_at":"2026-01-05T00:10:43.558Z","emitted_at":"2026-01-05T00:11:23.203Z","views":10}
```

**View snapshot, schema v2** (renames `views` to `view_count`, sends timestamps as epoch milliseconds, adds `type`)

```json
{"v":2,"type":"view_snapshot","event_id":"0d9a51f2c37be801","clip_id":"c_0004712","campaign_id":"k_00015","creator_id":"u_002513","observed_at_ms":1767572203558,"emitted_at_ms":1767572283203,"view_count":3150}
```

**Clip text, schema v2 only** (consumed by the classifier, section 8)

```json
{"v":2,"type":"clip_text","event_id":"5be0c2a1d4f79e13","clip_id":"c_8000001","campaign_id":"k_00007","caption":"Setting up Nimbus Wallet in 60 seconds","transcript":"okay so download nimbus wallet, tap create new wallet ..."}
```

| Field | Meaning |
|---|---|
| `event_id` | Unique id of the event. A redelivered event has the same `event_id` and an identical payload. |
| `observed_at` / `observed_at_ms` | When the poller read the view count. All business logic uses this time. |
| `emitted_at` / `emitted_at_ms` | When the poller emitted the event. Used only for the lateness rule. |
| `views` / `view_count` | The clip's **cumulative** view count at `observed_at`. It usually grows, but it can go down (see 3.3). |

A clip always belongs to the same campaign and creator. Clip ids are unique across campaigns.

### 3.2 Campaigns

`campaigns.json` is a JSON array:

```json
{"campaign_id":"k_00001","brand":"Nimbus 1","cpm_cents":100,"per_clip_cap_cents":5000,"budget_cents":237100,"start_at":"2026-01-05T00:00:00.000Z","end_at":"2026-01-07T18:00:00.000Z"}
```

`start_at` is informational. `end_at` is always a whole hour. Campaign values never change after they are created.

Some events reference campaigns that are not in `campaigns.json`. Those campaigns are in `campaigns-late.json`, and we only register them **after** the main stream has been sent (section 4.6).

### 3.3 What is in the stream

These are the real proportions in every preset. Your system must handle all of them.

| Pathology | Share | What it looks like |
|---|---|---|
| Duplicate delivery | ~1.5% of snapshots | The same event arrives twice, up to 20 minutes apart, with an identical payload. The sender's retries add more. |
| Out of order | most clips | Events arrive ordered by emit time, not observe time. A clip's snapshots can arrive in any order. |
| Late | ~0.4% | `emitted_at - observed_at` is more than 6 hours. |
| Views go down | ~2.3% of clips | A one-time downward revision (bot views removed) or a counter reset close to zero. Later snapshots grow from the new level. |
| Unknown campaign | ~1% of clips | The campaign is not in `campaigns.json` yet. |
| Malformed | ~0.05% of lines | Truncated JSON, missing fields, wrong types, negative views, bad timestamps, unknown version, bad ids. |
| Mixed versions | ~40% v2 | v1 and v2 are interleaved. |

The window: snapshots are observed between `2026-01-05T00:00:00.000Z` and `2026-01-12T00:00:00.000Z`.

---

## 4. Processing rules (exact)

Your numbers must match ours exactly, so these rules are precise. If anything here is ambiguous, see section 11.

### 4.1 Validation

A line is **valid** only if all of these hold. Otherwise it is `invalid_schema`.

1. It parses as a JSON object (not an array, not `null`).
2. `v` is the number `1` or `2`.
3. `event_id` matches `^[0-9a-f]{16}$`.
4. Type: for v1, `type` is absent or `"view_snapshot"`. For v2, `type` is `"view_snapshot"` or `"clip_text"`.
5. `clip_id` matches `^c_\d{7}$` and `campaign_id` matches `^k_\d{5}$`.
6. For `clip_text`: `caption` is a string of at most 5,000 characters and `transcript` is a string of at most 20,000 characters.
7. For `view_snapshot`:
   - `creator_id` matches `^u_\d{6}$`.
   - v1: `observed_at` and `emitted_at` match `YYYY-MM-DDTHH:MM:SS.sssZ` exactly and are real UTC instants (`2026-13-45T25:61:00.000Z` is invalid). `views` is a JSON integer.
   - v2: `observed_at_ms` and `emitted_at_ms` are JSON integers. `view_count` is a JSON integer.
   - Both timestamps are within `[2020-01-01T00:00:00.000Z, 2100-01-01T00:00:00.000Z)`.
   - The view count is between 0 and 2,000,000,000 inclusive.
   - `emitted_at >= observed_at`.

Unknown extra fields are ignored. A trailing `\r` on a line is ignored. Empty lines are ignored.

### 4.2 Classification, in this order

Every line gets exactly one outcome. Apply these in order and stop at the first that matches. Rules 2 to 4 apply only to view snapshots.

| # | Outcome | When |
|---|---|---|
| 1 | `invalid_schema` → DLQ | It fails 4.1. This applies to every line, including `clip_text`. |
| 2 | **late** → dropped | `emitted_at - observed_at > 6 hours`, meaning strictly more than 21,600,000 ms. Late events are counted, then ignored. They never go to the DLQ. |
| 3 | `unknown_campaign` → DLQ | The campaign is not registered at the time of processing (see 6.2 for when registration takes effect). |
| 4 | **accepted** | Everything else. |

Valid `clip_text` events go to the classifier. They do not count in any of the stats below and are not subject to rules 2 and 3.

### 4.3 Deduplication

Events are identified by `event_id`. Processing the same event any number of times, at any time, in any order, must have exactly the same effect as processing it once. This includes events re-sent long after the original, and events that pass through the DLQ and are replayed.

Malformed lines are identified by their `event_id` if the line is a JSON object with a string `event_id` field, and otherwise by the SHA-256 of the line. Identical garbage counts once.

### 4.4 Views at a time

For a clip and a time `t`, define **V(clip, t)** as the view count of the clip's **accepted** snapshot with the greatest `observed_at` strictly before `t`. If there is none, V is 0. No two accepted snapshots of one clip share an `observed_at`.

So the latest observation wins, including when it is lower than an earlier one. That is how downward revisions take effect.

### 4.5 Earnings

For each campaign and each clip `i` in it, at any moment:

```
earned_i = min( per_clip_cap_cents, floor( V(i, end_at) * cpm_cents / 1000 ) )
raw      = sum of earned_i over the campaign's clips
```

If `raw <= budget_cents`, each clip is paid `earned_i`.

If `raw > budget_cents`, the budget is split pro rata, with an exact remainder rule:

```
paid_i      = floor( earned_i * budget_cents / raw )
remainder_i = (earned_i * budget_cents) mod raw
left        = budget_cents - sum(paid_i)
```

Give 1 extra cent to each of the `left` clips with the largest `remainder_i`, with ties broken by `clip_id` ascending. Spend then equals the budget exactly.

All money is integer cents. `earned_i * budget_cents` fits comfortably in a signed 64-bit integer. **Spend must never exceed the budget**, not even for a moment while data is flowing; we sample it during the run.

Earnings are always computed from the data processed so far. They change as new snapshots arrive, including downward when views are revised. Payouts are out of scope.

### 4.6 Unknown campaigns and DLQ replay

After the main stream, we register the campaigns in `campaigns-late.json` with `POST /v1/admin/campaigns`, and then call `POST /v1/dlq/replay` with reason `unknown_campaign`.

- Every replayed event is classified again (4.2) and processed normally.
- Events that still fail stay pending in the DLQ, without being duplicated.
- A replay of `invalid_schema` is allowed and changes nothing.

---

## 5. Architecture requirements

### 5.1 Services

Use these exact service names in `docker-compose.yml`. We stop, kill and restart them by name.

| Service | Port | Responsibility |
|---|---|---|
| `gateway` | 8080 | `POST /v1/events`. Validates every line, applies backpressure, and publishes to the broker. |
| `aggregator` | none | Consumes view snapshots. Applies 4.2 to 4.4 and keeps the data needed for V(clip, t) and top-clips. Owns the stats in 6.3. |
| `earnings` | none | **The only service that computes spend and earnings (4.5).** Recomputes whenever a clip's V(end_at) may have changed. |
| `api` | 8081 | Every endpoint in section 6 except `POST /v1/events`. Owns the campaign catalog. |
| `classifier` | none | Consumes `clip_text` events and stores relevance results (section 8). |
| `broker` | your choice | Your message broker. It must be named `broker`. |

Add Postgres and anything else you need, named as you like.

### 5.2 Rules

1. **One process per service, one container per service.** Services talk to each other **only through the broker**. No service-to-service HTTP calls.
2. **Broker:** choose Redis Streams, BullMQ, Kafka or Redpanda, NATS JetStream, or RabbitMQ. Justify the choice in your README, including what it can lose and when.
3. **Data ownership:** one Postgres instance is fine, with **one schema per service**. A service writes only to its own schema. Two read-only exceptions are allowed:
   - `api` may read other services' schemas.
   - `aggregator` and `earnings` may read the campaign catalog owned by `api`.
4. **Spend and earnings belong to `earnings`.**
   - `api` serves the latest results `earnings` has produced and never computes them itself.
   - While `earnings` is down, the spend and earnings endpoints keep returning the last results it produced. They freeze while ingestion carries on.
   - When `earnings` comes back, it must catch up to the exact values.
   - We test this.
5. **Atomic effects:** whenever a service changes its database and also publishes an event, a crash between the two must not lose or duplicate the effect. Use an outbox or an equivalent, and explain it.
6. **Versioned contracts:** every event between your services carries a version. Document each internal event in the README.
7. **The 202 contract:** when `gateway` returns 202, every line in that request must be safe, meaning durably stored in the broker or the DLQ. If it cannot guarantee that, it must return 429 or 503 with `Retry-After`. It must never return 202 for data it could lose.
8. **Backpressure is driven by lag.** `gateway` decides to return 429 or 503 from how far behind the consumers are (for example consumer lag, pending messages or broker memory), not from a fixed rate limit. Explain your thresholds.
9. **Resources:**
   - Each of **your five services** (`gateway`, `aggregator`, `earnings`, `api`, `classifier`) must stay under **1.5 GB** of memory for the whole run.
   - Postgres and the broker are excluded from that cap. Size them within Docker's 10 GB total: about 4 GB for Postgres and 2 GB for the broker is a sensible start.
   - If your broker keeps messages in memory (Redis), trim streams after they are consumed so memory stays bounded.
   - Leave about **20 GB of free disk** for the raw data, Postgres and broker storage.
10. **Health:** `GET /healthz` on ports 8080 and 8081 returns 200 when the service is ready.

---

## 6. Public API

All responses are JSON. Timestamps are ISO 8601 UTC with milliseconds. Extra fields in responses are allowed, and field order does not matter.

### 6.1 `POST :8080/v1/events`

- Body: NDJSON (`content-type: application/x-ndjson`), up to 10,000 lines and 8 MB.
- Every line is handled on its own. A malformed line never fails the rest of the request.
- Response `202`: `{"accepted": 4997, "rejected": 3}`. `rejected` is the number of lines that failed 4.1, which you have sent to the DLQ. `accepted` is the number of valid lines.
- Backpressure: `429` or `503` with a `Retry-After` header (seconds).
- A body over the limits gets `413`.

### 6.2 `POST :8081/v1/admin/campaigns`

- Body: a JSON array of campaign objects (the shape of `campaigns.json`). Upsert by `campaign_id`.
- Response `200`: `{"upserted": 40}`.
- **Registration takes effect when the 200 is returned.** Any event that `gateway` receives after that response, and any DLQ replay requested after it, must see these campaigns as registered. We send events immediately after the 200, without waiting.
- Two clean ways to meet this:
  - `api` writes the catalog to a table that `aggregator` reads (allowed by 5.2 rule 3).
  - `api` publishes the change and answers only after `aggregator` confirms it has applied it.
- `earnings` may pick up new campaigns asynchronously. Registration must succeed even while `earnings` is down.
- We call this with `campaigns.json` before sending any events.

### 6.3 `GET :8081/v1/stats`

```json
{"distinct_valid_events": 22111165, "late_dropped": 90124, "dlq_pending": {"invalid_schema": 11238, "unknown_campaign": 223949}}
```

| Field | Meaning |
|---|---|
| `distinct_valid_events` | Number of distinct accepted view snapshots (outcome 4 in 4.2). |
| `late_dropped` | Number of distinct late view snapshots. |
| `dlq_pending.invalid_schema` | Number of distinct invalid lines in the DLQ (identity as in 4.3). |
| `dlq_pending.unknown_campaign` | Number of distinct events waiting in the DLQ for their campaign. |

### 6.4 `POST :8081/v1/dlq/replay`

- Body: `{"reason": "unknown_campaign"}` or `{"reason": "invalid_schema"}`.
- Response `202`: `{"replayed": 223949}`, the number of DLQ entries submitted for reprocessing. Processing can finish asynchronously.

### 6.5 `GET :8081/v1/campaigns/{campaign_id}/spend`

```json
{"campaign_id":"k_00001","budget_cents":237100,"cpm_cents":100,"per_clip_cap_cents":5000,"end_at":"2026-01-07T18:00:00.000Z",
 "raw_earnings_cents":374299,"spend_cents":237100,"budget_exhausted":true,"paid_clips":598}
```

- `raw_earnings_cents` is `raw`, and `spend_cents` is the sum of `paid_i` (4.5), as last computed by `earnings`.
- `budget_exhausted` is `raw > budget_cents`. `paid_clips` is the number of clips with `paid_i > 0`.
- If the campaign is registered but `earnings` has not produced results for it yet, return `200` with zeros.
- `404` if the campaign is not registered.

### 6.6 `GET :8081/v1/creators/{creator_id}/earnings`

```json
{"creator_id":"u_000000","total_cents":175162,
 "campaigns":[{"campaign_id":"k_00001","clips":3,"earned_cents":331},{"campaign_id":"k_00002","clips":3,"earned_cents":4373}]}
```

- One entry per campaign where the creator's paid amount is above 0, sorted by `campaign_id` ascending.
- `clips` is the number of the creator's clips in that campaign with `paid_i > 0`. `earned_cents` is their sum.
- An unknown creator returns `200` with `total_cents: 0` and an empty list.

### 6.7 `GET :8081/v1/campaigns/{campaign_id}/top-clips?from=&to=&limit=&cursor=`

The campaign's clips ranked by views gained in the window.

- `views_gained = V(clip, to) - V(clip, from)`. Only clips with `views_gained > 0` are listed.
- Order: `views_gained` descending, then `clip_id` ascending.
- `from` and `to` are ISO timestamps on whole hours, with `to > from` and `to - from <= 168 hours`. Otherwise return `400`.
- `limit` is 1 to 200, default 50.
- `cursor` is the opaque `next_cursor` from the previous page. Use keyset pagination, not OFFSET. `next_cursor` is `null` on the last page.
- `404` if the campaign is not registered.

```json
{"campaign_id":"k_00001","from":"2026-01-08T03:00:00.000Z","to":"2026-01-09T21:00:00.000Z",
 "items":[{"clip_id":"c_0012093","creator_id":"u_003303","views_gained":184220}],
 "next_cursor":"eyJnIjoxODQyMjAsImMiOiJjXzAwMTIwOTMifQ"}
```

### 6.8 `GET :8081/v1/clips/{clip_id}/relevance`

See section 8. Returns `404` until the clip has been classified.

---

## 7. Performance targets

These are measured on a reference laptop: 8 or more cores, 16 GB RAM, SSD, Docker with 6 CPUs and 10 GB memory. Report your own machine and numbers in the README.

| # | Target |
|---|---|
| P1 | With the **full** preset sent at `--rate 20000` with a 60 s burst at 10×, every event is processed (stats match the expected values) **within 45 minutes of the first request**. A strong result is under 20 minutes. |
| P2 | After the sender finishes, the backlog drains within 5 minutes. |
| P3 | During the burst, `gateway` answers every request within 10 s with 202, 429 or 503. No container restarts or runs out of memory. |
| P4 | After the full run, with one client sending requests one at a time, the p95 latencies are: `top-clips` ≤ 500 ms, `spend` ≤ 100 ms, `creator earnings` ≤ 150 ms, `stats` ≤ 200 ms. |

Getting there will need pre-aggregated data, batched writes and a deliberate Postgres layout. Postgres is required. Your README must include the `EXPLAIN (ANALYZE, BUFFERS)` output for your **top-clips** query on the full dataset, with a short note on why the plan is good.

---

## 8. AI: clip relevance (about 2.5 hours of the budget)

Brands only want clips that are on-brief. Build the `classifier` service.

- **Input:** `clip_text` events from the broker. They arrive through `gateway` like everything else.
- **Output:** `GET :8081/v1/clips/{clip_id}/relevance` returns

  ```json
  {"clip_id":"c_9000001","campaign_id":"k_00007","on_brief":true,"score":0.91,"model":"your-model-name"}
  ```

  Results must be available within 60 seconds of a batch of 100 clips being ingested.
- **Data:**
  - `web2-kit/ai/briefs.json` holds three campaign briefs, and `labeling-rules.md` the exact labelling rules.
  - `dev.jsonl` holds 44 labelled examples.
  - We score you on a **hidden set of 120 clips**. It uses the same briefs and rules, but different and messier text: long transcripts with buried mentions, speech-to-text errors, Hindi in Devanagari and Latin script, Hinglish, sarcasm, hashtag spam, rule violations, and captions that try to instruct your model.
- **Approach:** any approach is fine (LLM, embeddings, a trained classifier, rules, or a mix). The dev set is small on purpose. We are looking at how you generalise and how honestly you measure.
- **Cost and runtime:** at most **$0.50 per 1,000 classifications** and a p95 of at most 2 s per clip.
  - If you call a hosted model, it must be reachable through an OpenAI-compatible API, configured only by these environment variables, passed through in your compose file exactly like this:

    ```yaml
      classifier:
        environment:
          LLM_BASE_URL: ${LLM_BASE_URL:-}
          LLM_API_KEY: ${LLM_API_KEY:-}
          LLM_MODEL: ${LLM_MODEL:-}
    ```

    Name the provider and exact model in your README. We set these variables in our shell, using our own key, before running your stack.
  - A local model must run on CPU inside the container.
- **`EVAL.md`** (about half a page):
  - your approach and why
  - precision, recall and F1 on the dev set, and **how** you measured them without tuning on the rows you report (for example cross-validation or a held-out split)
  - your threshold and why
  - three representative errors and their cause
  - cost per 1,000 clips and p95 latency
  - **your predicted F1 on the hidden set.** We compare it with the real result, so an honest estimate scores better than an optimistic one.

---

## 9. What we will do to your system

We run an automated harness on your repo with **seeds you have not seen**. We do not give you the exact scripts, but these are the categories. Design for them.

1. **Unit tests:** we run `make test`.
2. **Full volume:** the full preset at 20,000 events/s with a 10× burst. We measure P1 to P4 and compare every number in section 6 with ground truth, and we sample spend during the run to check that it never exceeds the budget.
3. **Broker restart:** we restart `broker` gracefully once while the system is idle. Your services must reconnect on their own and lose nothing.
4. **Crashes:** on the medium preset, we `SIGKILL` one of `gateway`, `aggregator`, `earnings` or `api` during the burst, keep it down for 2 minutes, and start it again. We do this once per service, each time on a fresh stack. Afterwards every number must still match exactly. We do not kill Postgres.
5. **Service ownership:** we stop `earnings` while data is flowing, check that spend and earnings freeze, start it again, and check that it catches up exactly.
6. **Replays:** we re-send millions of lines you have already processed. Nothing may change.
7. **Hostile input:** we inject extra malformed lines of kinds not in the generator. They must land in the DLQ, and everything else must keep flowing.
8. **Late campaigns:** we register `campaigns-late.json` and replay the DLQ, as in 4.6.
9. **AI:** we post the 120 hidden clips and score your results.

Partial credit is real. A system that is exactly right but slower than the targets scores far better than a fast one that is wrong.

---

## 10. Deliverables

A Git repository (GitHub or GitLab link, private with access granted, or a zip) containing:

| Item | Contents |
|---|---|
| `docker-compose.yml` | `docker compose up -d --build` from the repo root brings up everything, with the service names in 5.1. Both health checks pass within 10 minutes on a clean machine. |
| `make test` | Runs your unit tests **inside Docker**, so it needs only Docker and `make` on our machine. At minimum it covers: validation and the classification order (4.1, 4.2); V(clip, t) and `views_gained` including a downward revision that arrives out of order (4.4); and budget allocation including the remainder rule (4.5). |
| `README.md` | Hours spent and anything unfinished, at the top. Then: how to run; an architecture diagram; broker choice and why; internal event contracts with versions; data model with partitioning and indexes; how you get exactly-once effects; what happens when each service dies mid-batch; your backpressure thresholds; the `EXPLAIN` output from section 7; your measured P1 to P4 numbers and machine specs; known limitations. |
| `DESIGN.md` | At most 300 words, answering the question below. |
| `EVAL.md` | Section 8. |
| `AI_USAGE.md` | Which AI coding tools you used, for which parts, and what you changed or rejected. AI tools are allowed. You must be able to explain every line in the follow-up call. |

**`DESIGN.md` question:** at 500 million view snapshots a day across 50 million live clips (about 5,800 per second on average, 60,000 per second at peak), what breaks first in your current system, how would you see it coming (name the metrics you would alert on), and what would you change? Include rough numbers: rows per day, bytes per day, write rate.

---

## 11. Rules and assumptions

- If something is unclear, make a reasonable assumption, write it under **Assumptions** in your README, and keep going. Questions go to the person who sent you this assessment.
- Everything must run locally. No paid infrastructure, except an optional hosted model for the classifier (section 8).
- Do not modify the generator or the checker to make tests pass. We run our own copies.
- Your code must be your own work, apart from libraries and disclosed AI assistance.

## 12. Submission checklist

- [ ] `docker compose up -d --build` works from a clean clone, with services `gateway`, `aggregator`, `earnings`, `api`, `classifier`, `broker`
- [ ] `make test` passes using only Docker and `make`
- [ ] The small-preset flow in `web2-kit/README.md` ends with `... checks passed, 0 failures`
- [ ] The full preset has run end to end on your machine, with numbers in the README
- [ ] You have tried killing a service, stopping `earnings`, restarting `broker` and replaying, not just reasoned about them
- [ ] `README.md`, `DESIGN.md`, `EVAL.md`, `AI_USAGE.md`
