// One Postgres schema per service. Each service creates only its own schema at startup
// (idempotent), so a service never writes DDL or rows into another service's schema.

export const API_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS api;
CREATE TABLE IF NOT EXISTS api.campaigns (
  campaign_id        int PRIMARY KEY,
  brand              text,
  cpm_cents          bigint NOT NULL,
  per_clip_cap_cents bigint NOT NULL,
  budget_cents       bigint NOT NULL,
  start_at           timestamptz,
  end_at             timestamptz NOT NULL,
  registered_at      timestamptz NOT NULL DEFAULT now()
);
`;

export const AGG_PARTITIONS = 8;

export const AGG_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS agg;

-- Dedup ledger: one row per distinct accepted or late snapshot (outcome 'A' or 'L').
CREATE TABLE IF NOT EXISTS agg.seen_events (
  event_id bigint PRIMARY KEY,
  outcome  "char" NOT NULL
) WITH (autovacuum_enabled = false); -- insert-only: routine vacuum only re-reads it (wraparound vacuum still runs)

-- Accepted snapshots. Hash partitioned by clip so each partition's index stays cache friendly.
-- The primary key carries views (INCLUDE) so V(clip, t) is an index-only backward scan.
CREATE TABLE IF NOT EXISTS agg.snapshots (
  clip_id     int    NOT NULL,
  observed_ms bigint NOT NULL,
  views       bigint NOT NULL,
  PRIMARY KEY (clip_id, observed_ms) INCLUDE (views)
) PARTITION BY HASH (clip_id);
${Array.from({ length: AGG_PARTITIONS }, (_, i) => `CREATE TABLE IF NOT EXISTS agg.snapshots_p${i} PARTITION OF agg.snapshots FOR VALUES WITH (MODULUS ${AGG_PARTITIONS}, REMAINDER ${i});`).join('\n')}

-- Clip directory (a clip always has one campaign and creator).
CREATE TABLE IF NOT EXISTS agg.clips (
  clip_id     int PRIMARY KEY,
  campaign_id int NOT NULL,
  creator_id  int NOT NULL
);
CREATE INDEX IF NOT EXISTS clips_by_campaign ON agg.clips (campaign_id, clip_id) INCLUDE (creator_id);

-- V(clip, end_at) as of the latest accepted snapshot observed before the campaign end.
CREATE TABLE IF NOT EXISTS agg.clip_state (
  clip_id   int PRIMARY KEY,
  v_end_obs bigint NOT NULL,
  v_end     bigint NOT NULL
) WITH (fillfactor = 70); -- free space per page so updates stay HOT (no index write)

-- Dead letter queue. identity is the event_id (or line hash for garbage), unique per reason.
CREATE TABLE IF NOT EXISTS agg.dlq (
  reason     text NOT NULL,
  identity   text NOT NULL,
  payload    text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reason, identity)
);

-- Transactional outbox for clip.changes (written in the same transaction as clip_state).
CREATE TABLE IF NOT EXISTS agg.outbox (
  id          bigserial PRIMARY KEY,
  clip_id     int    NOT NULL,
  campaign_id int    NOT NULL,
  creator_id  int    NOT NULL,
  v_end       bigint NOT NULL
);

-- Counters maintained in the same transactions as the rows they count, so /v1/stats is O(1).
CREATE TABLE IF NOT EXISTS agg.stats (
  id                    int PRIMARY KEY,
  distinct_valid_events bigint NOT NULL,
  late_dropped          bigint NOT NULL,
  dlq_invalid_schema    bigint NOT NULL,
  dlq_unknown_campaign  bigint NOT NULL
);
INSERT INTO agg.stats VALUES (1, 0, 0, 0, 0) ON CONFLICT DO NOTHING;
`;

export const EARN_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS earn;

-- Inputs: the latest V(clip, end_at) received from the aggregator, with its outbox revision.
CREATE TABLE IF NOT EXISTS earn.clip_values (
  clip_id     int PRIMARY KEY,
  campaign_id int    NOT NULL,
  creator_id  int    NOT NULL,
  v_end       bigint NOT NULL,
  rev         bigint NOT NULL
) WITH (fillfactor = 70);

-- Outputs served by api.
CREATE TABLE IF NOT EXISTS earn.campaign_spend (
  campaign_id      int PRIMARY KEY,
  raw_cents        bigint  NOT NULL,
  spend_cents      bigint  NOT NULL,
  budget_exhausted boolean NOT NULL,
  paid_clips       int     NOT NULL,
  computed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS earn.creator_campaign (
  creator_id   int    NOT NULL,
  campaign_id  int    NOT NULL,
  clips        int    NOT NULL,
  earned_cents bigint NOT NULL,
  PRIMARY KEY (creator_id, campaign_id)
) WITH (fillfactor = 70);
`;

export const CLS_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS cls;
CREATE TABLE IF NOT EXISTS cls.relevance (
  clip_id       int PRIMARY KEY,
  campaign_id   int     NOT NULL,
  event_id      text    NOT NULL,
  on_brief      boolean NOT NULL,
  score         real    NOT NULL,
  model         text    NOT NULL,
  classified_at timestamptz NOT NULL DEFAULT now()
);
`;
