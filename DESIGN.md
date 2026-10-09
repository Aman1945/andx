# Design at 500M snapshots/day

**Load.** 500M/day is ~5,800/s average and 60,000/s at peak. Accepted snapshots are ~24 bytes of payload (clip, observed_ms, views) but ~70 bytes per row once tuple and primary-key overhead are counted, plus ~40 bytes per `seen_events` row: roughly **55 GB/day of table and index growth** and 30 to 60 GB/day of WAL. The Redis stream sees ~125 GB/day of raw NDJSON in transit.

**What breaks first.** The aggregator. It is one process writing one transaction at a time into a single Postgres, and every accepted event costs two random B-tree inserts (`seen_events`, `snapshots`). On the reference laptop it sustains a few tens of thousands of lines per second; 60k/s at peak would build lag, and the gateway would answer 429 until the burst passed. Close behind: the `seen_events` index outgrows memory after a few days (dedup becomes disk-bound), and earnings recomputes whole campaigns, so one very large campaign makes every flush slow.

**How we would see it coming.** Alert on: consumer lag on `ingest.views` (entries and age of the oldest entry), the gateway's 429/503 rate, aggregator batch commit latency p95, Postgres buffer cache hit ratio on `seen_events` and `snapshots`, WAL generation rate and checkpoint duration, earnings flush duration and `clip.changes` lag, Redis `used_memory` against `maxmemory`, and disk-free days remaining.

**What we would change.**
1. Partition the stream by clip (Kafka or Redpanda, ~32 partitions) and run one aggregator per partition. Clip ownership never crosses partitions, so V(clip, t) stays single-writer.
2. Move dedup to a time-bounded store: duplicates arrive within 20 minutes in practice, so keep `seen_events` partitioned by day and drop old days, or use a per-partition RocksDB keyed by event_id.
3. Store snapshots as hourly per-clip summaries (the API only needs whole-hour bounds plus each campaign's end), cutting rows by 10x or more, with raw events in object storage for audit and replay.
4. Shard Postgres by campaign (Citus or application sharding) and keep earnings incremental per clip, recomputing a campaign's remainder split only when it is over budget.
