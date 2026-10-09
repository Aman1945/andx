// aggregator: consumes ingest.views. Applies classification (4.2), dedup (4.3) and keeps the
// data behind V(clip, t) (4.4) and the stats (6.3). Every batch is one Postgres transaction;
// the stream entries are acked only after commit, so a crash re-delivers and the idempotent
// inserts (ON CONFLICT DO NOTHING on event_id) make the replay a no-op.
// Changes to V(clip, end_at) go to earnings through a transactional outbox.
import type pg from 'pg';
import { classify, eventIdToBigint } from '../../../shared/src/validate.ts';
import { makePool, makeRedis, STREAMS, GroupReader, ensureGroup, log, retryUntil, sleep } from '../../../shared/src/infra.ts';
import { AGG_SCHEMA } from '../../../db/schemas.ts';

const SVC = 'aggregator';
const GROUP = 'aggregator';
const CONSUMER = 'aggregator-1';
const READ_COUNT = Number(process.env.AGG_READ_COUNT ?? 8); // stream entries per transaction
const RELAY_CHUNK = 20_000;
const REPLAY_CHUNK = 20_000;

// [event_id(hex), clip, campaign, creator, observed_ms, emitted_ms, views]
type View = [string, number, number, number, number, number, number];
type InvalidLine = [string, string]; // [identity, raw line]

const pool = makePool(4);
const redis = makeRedis(SVC);
const viewsReader = new GroupReader(redis, STREAMS.views, GROUP, CONSUMER);
const cmdReader = new GroupReader(redis, STREAMS.commands, GROUP, CONSUMER);

// Campaign catalog (owned by api, read-only here). Campaigns never change once created and are
// never removed, so a hit is cached forever; a miss re-queries Postgres for that batch. That is
// what makes registration take effect as soon as api returns 200.
const endAtMs = new Map<number, number>();
const knownClips = new Set<number>();
let dlqUnknownPending = 0;
// Campaigns that have (or had) events in the unknown_campaign DLQ. Only accepted events of these
// campaigns can be waiting there, so only they need the DLQ delete. A superset is always safe.
const dlqCampaigns = new Set<number>();

async function refreshCatalog(ids: number[]) {
  if (ids.length === 0) return;
  const r = await pool.query<{ campaign_id: number; end_ms: number }>(
    `SELECT campaign_id, (extract(epoch FROM end_at) * 1000)::bigint AS end_ms FROM api.campaigns WHERE campaign_id = ANY($1::int[])`,
    [ids],
  );
  for (const row of r.rows) endAtMs.set(row.campaign_id, row.end_ms);
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

type Effects = { accepted: number; late: number; invalid: number; unknownAdded: number; unknownResolved: number; outbox: number; newClips: number[] };

/** Applies one batch of lines inside an open transaction. */
async function applyBatch(client: pg.PoolClient, views: View[], invalid: InvalidLine[]): Promise<Effects> {
  const fx: Effects = { accepted: 0, late: 0, invalid: 0, unknownAdded: 0, unknownResolved: 0, outbox: 0, newClips: [] };

  // Catalog lookups for campaigns we have not seen as registered.
  const missing = new Set<number>();
  for (const v of views) if (!endAtMs.has(v[2])) missing.add(v[2]);
  await refreshCatalog([...missing]);

  const late: View[] = [];
  const acc: View[] = [];
  const unk: View[] = [];
  for (const v of views) {
    const outcome = classify({ observedMs: v[4], emittedMs: v[5], campaignId: String(v[2]) }, () => endAtMs.has(v[2]));
    if (outcome === 'late') late.push(v);
    else if (outcome === 'unknown_campaign') unk.push(v);
    else acc.push(v);
  }

  // invalid_schema -> DLQ, identity-deduped.
  const inv = dedupe(invalid, (i) => i[0]);
  if (inv.length) {
    const r = await client.query(
      `INSERT INTO agg.dlq (reason, identity, payload)
       SELECT 'invalid_schema', i, p FROM unnest($1::text[], $2::text[]) AS t(i, p)
       ON CONFLICT DO NOTHING`,
      [inv.map((i) => i[0]), inv.map((i) => i[1])],
    );
    fx.invalid = r.rowCount ?? 0;
  }

  // late -> counted once, then ignored.
  const lateU = dedupe(late, (v) => v[0]);
  if (lateU.length) {
    const r = await client.query(
      `INSERT INTO agg.seen_events (event_id, outcome) SELECT e, 'L' FROM unnest($1::bigint[]) AS e ON CONFLICT DO NOTHING`,
      [lateU.map((v) => eventIdToBigint(v[0]))],
    );
    fx.late = r.rowCount ?? 0;
  }

  // accepted -> dedup ledger first; only events that are new here have any effect.
  const accU = dedupe(acc, (v) => v[0]);
  if (accU.length) {
    const byBig = new Map<string, View>();
    for (const v of accU) byBig.set(eventIdToBigint(v[0]), v);
    const r = await client.query<{ e: string }>(
      `INSERT INTO agg.seen_events (event_id, outcome) SELECT e, 'A' FROM unnest($1::bigint[]) AS e
       ON CONFLICT DO NOTHING RETURNING event_id::text AS e`,
      [[...byBig.keys()]],
    );
    const fresh: View[] = r.rows.map((row) => byBig.get(row.e)!);
    fx.accepted = fresh.length;

    if (fresh.length) {
      await client.query(
        `INSERT INTO agg.snapshots (clip_id, observed_ms, views)
         SELECT * FROM unnest($1::int[], $2::bigint[], $3::bigint[]) ON CONFLICT DO NOTHING`,
        [fresh.map((v) => v[1]), fresh.map((v) => v[4]), fresh.map((v) => v[6])],
      );

      const newClips = new Map<number, View>();
      for (const v of fresh) if (!knownClips.has(v[1])) newClips.set(v[1], v);
      if (newClips.size) {
        const nc = [...newClips.values()];
        await client.query(
          `INSERT INTO agg.clips (clip_id, campaign_id, creator_id)
           SELECT * FROM unnest($1::int[], $2::int[], $3::int[]) ON CONFLICT DO NOTHING`,
          [nc.map((v) => v[1]), nc.map((v) => v[2]), nc.map((v) => v[3])],
        );
        fx.newClips = nc.map((v) => v[1]);
      }

      // Events that were waiting in the DLQ and are now accepted leave it.
      const maybeInDlq = dlqUnknownPending > 0 ? fresh.filter((v) => dlqCampaigns.has(v[2])) : [];
      if (maybeInDlq.length) {
        const d = await client.query(`DELETE FROM agg.dlq WHERE reason = 'unknown_campaign' AND identity = ANY($1::text[])`, [maybeInDlq.map((v) => v[0])]);
        fx.unknownResolved = d.rowCount ?? 0;
      }

      // V(clip, end_at): keep the latest observation before the campaign end; if it moved,
      // write an outbox row in this same transaction.
      const best = new Map<number, View>();
      for (const v of fresh) {
        if (v[4] >= endAtMs.get(v[2])!) continue;
        const cur = best.get(v[1]);
        if (!cur || v[4] > cur[4]) best.set(v[1], v);
      }
      if (best.size) {
        const b = [...best.values()];
        const o = await client.query(
          `WITH up AS (
             INSERT INTO agg.clip_state (clip_id, v_end_obs, v_end)
             SELECT * FROM unnest($1::int[], $2::bigint[], $3::bigint[])
             ON CONFLICT (clip_id) DO UPDATE SET v_end_obs = EXCLUDED.v_end_obs, v_end = EXCLUDED.v_end
             WHERE agg.clip_state.v_end_obs < EXCLUDED.v_end_obs
             RETURNING clip_id, v_end)
           INSERT INTO agg.outbox (clip_id, campaign_id, creator_id, v_end)
           SELECT up.clip_id, m.campaign_id, m.creator_id, up.v_end
           FROM up JOIN unnest($1::int[], $4::int[], $5::int[]) AS m(clip_id, campaign_id, creator_id) USING (clip_id)
           ORDER BY up.clip_id`,
          [b.map((v) => v[1]), b.map((v) => v[4]), b.map((v) => v[6]), b.map((v) => v[2]), b.map((v) => v[3])],
        );
        fx.outbox = o.rowCount ?? 0;
      }
    }
  }

  // unknown_campaign -> DLQ, waiting for the campaign to be registered and a replay.
  const unkU = dedupe(unk, (v) => v[0]);
  if (unkU.length) {
    for (const v of unkU) dlqCampaigns.add(v[2]);
    const r = await client.query(
      `INSERT INTO agg.dlq (reason, identity, payload)
       SELECT 'unknown_campaign', i, p FROM unnest($1::text[], $2::text[]) AS t(i, p)
       ON CONFLICT DO NOTHING`,
      [unkU.map((v) => v[0]), unkU.map((v) => JSON.stringify(v))],
    );
    fx.unknownAdded = r.rowCount ?? 0;
  }

  await client.query(
    `UPDATE agg.stats SET
       distinct_valid_events = distinct_valid_events + $1,
       late_dropped = late_dropped + $2,
       dlq_invalid_schema = dlq_invalid_schema + $3,
       dlq_unknown_campaign = dlq_unknown_campaign + $4 - $5
     WHERE id = 1`,
    [fx.accepted, fx.late, fx.invalid, fx.unknownAdded, fx.unknownResolved],
  );
  return fx;
}

async function inTransaction(views: View[], invalid: InvalidLine[]): Promise<Effects> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fx = await applyBatch(client, views, invalid);
    await client.query('COMMIT');
    // Only after commit: update in-memory caches.
    for (const c of fx.newClips) knownClips.add(c);
    dlqUnknownPending += fx.unknownAdded - fx.unknownResolved;
    return fx;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Publishes committed outbox rows to clip.changes, then deletes them. At-least-once; earnings dedups by rev. */
async function relayOutbox() {
  for (;;) {
    const r = await pool.query<{ id: number; clip_id: number; campaign_id: number; creator_id: number; v_end: number }>(
      `SELECT id, clip_id, campaign_id, creator_id, v_end FROM agg.outbox ORDER BY id LIMIT ${RELAY_CHUNK}`,
    );
    if (r.rows.length === 0) return;
    const items = r.rows.map((x) => [x.id, x.clip_id, x.campaign_id, x.creator_id, x.v_end]);
    await redis.xadd(STREAMS.clipChanges, '*', 'm', JSON.stringify({ v: 1, type: 'clip_v_end_changed', items }));
    await pool.query(`DELETE FROM agg.outbox WHERE id <= $1`, [r.rows[r.rows.length - 1].id]);
    if (r.rows.length < RELAY_CHUNK) return;
  }
}

/** DLQ replay: re-classifies pending entries in key order; still-unknown ones stay put, not duplicated. */
async function replay(reason: string) {
  if (reason !== 'unknown_campaign') {
    log(SVC, 'replay is a no-op for this reason', { reason });
    return;
  }
  let after = '';
  let resolved = 0;
  for (;;) {
    const r = await pool.query<{ identity: string; payload: string }>(
      `SELECT identity, payload FROM agg.dlq WHERE reason = 'unknown_campaign' AND identity > $1 ORDER BY identity LIMIT ${REPLAY_CHUNK}`,
      [after],
    );
    if (r.rows.length === 0) break;
    after = r.rows[r.rows.length - 1].identity;
    const views = r.rows.map((x) => JSON.parse(x.payload) as View);
    // Force a catalog lookup for every campaign in the chunk, so newly registered ones are seen.
    const fx = await inTransaction(views, []);
    resolved += fx.unknownResolved;
    await relayOutbox();
  }
  log(SVC, 'replay done', { reason, resolved, still_pending: dlqUnknownPending });
}

async function handleCommands() {
  const msgs = await cmdReader.read(10, 0);
  for (const m of msgs) {
    if (m.body?.v === 1 && m.body.type === 'dlq_replay') await replay(m.body.reason);
    else log(SVC, 'skipping unknown command', { id: m.id });
    await cmdReader.ackAndDelete([m.id]);
  }
}

async function main() {
  await retryUntil('postgres', SVC, () => pool.query(AGG_SCHEMA));
  await retryUntil('api.campaigns', SVC, () => pool.query('SELECT 1 FROM api.campaigns LIMIT 1'));
  const all = await pool.query<{ campaign_id: number; end_ms: number }>(
    `SELECT campaign_id, (extract(epoch FROM end_at) * 1000)::bigint AS end_ms FROM api.campaigns`,
  );
  for (const row of all.rows) endAtMs.set(row.campaign_id, row.end_ms);
  const s = await pool.query<{ n: number }>(`SELECT dlq_unknown_campaign AS n FROM agg.stats WHERE id = 1`);
  dlqUnknownPending = s.rows[0]?.n ?? 0;
  const dc = await pool.query<{ c: number }>(`SELECT DISTINCT (payload::jsonb->>2)::int AS c FROM agg.dlq WHERE reason = 'unknown_campaign'`);
  for (const row of dc.rows) dlqCampaigns.add(row.c);
  await retryUntil('broker', SVC, async () => {
    await ensureGroup(redis, STREAMS.views, GROUP);
    await ensureGroup(redis, STREAMS.commands, GROUP);
  });
  await relayOutbox(); // rows committed before a crash but not yet published
  log(SVC, 'ready', { campaigns: endAtMs.size, dlq_unknown: dlqUnknownPending });

  let lines = 0;
  let lastLog = Date.now();
  for (;;) {
    try {
      await handleCommands();
      const msgs = await viewsReader.read(READ_COUNT, 500);
      if (msgs.length) {
        const views: View[] = [];
        const invalid: InvalidLine[] = [];
        for (const m of msgs) {
          if (m.body?.v !== 1 || m.body.type !== 'ingest_batch') {
            log(SVC, 'skipping message with unknown contract', { id: m.id });
            continue;
          }
          for (const v of m.body.views) views.push(v);
          for (const i of m.body.invalid) invalid.push(i);
        }
        await inTransaction(views, invalid);
        await viewsReader.ackAndDelete(msgs.map((m) => m.id));
        await relayOutbox();
        lines += views.length + invalid.length;
      }
      if (Date.now() - lastLog > 10_000) {
        log(SVC, 'progress', { lines_since_last: lines, dlq_unknown: dlqUnknownPending, known_clips: knownClips.size });
        lines = 0;
        lastLog = Date.now();
      }
    } catch (e) {
      log(SVC, 'batch failed, retrying from pending', { error: String(e) });
      viewsReader.rewind();
      cmdReader.rewind();
      await sleep(1000);
      await retryUntil('broker groups', SVC, async () => {
        await ensureGroup(redis, STREAMS.views, GROUP);
        await ensureGroup(redis, STREAMS.commands, GROUP);
      });
    }
  }
}

main().catch((e) => {
  log(SVC, 'fatal', { error: String(e) });
  process.exit(1);
});
