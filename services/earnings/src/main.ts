// earnings: the only service that computes spend and earnings (4.5).
// Input: clip.changes (V(clip, end_at) with a monotonically increasing rev from the aggregator outbox).
// It applies changes in memory, and periodically flushes one transaction that persists the inputs
// (clip_values) and the outputs (campaign_spend, creator_campaign) together, then acks the stream
// entries it covered. A crash before the ack re-delivers them; rev makes re-application a no-op.
import { allocate } from '../../../shared/src/money.ts';
import type { CampaignTerms } from '../../../shared/src/money.ts';
import { makePool, makeRedis, STREAMS, GroupReader, ensureGroup, log, retryUntil } from '../../../shared/src/infra.ts';
import { EARN_SCHEMA } from '../../../db/schemas.ts';

const SVC = 'earnings';
const GROUP = 'earnings';
const CONSUMER = 'earnings-1';
const MIN_FLUSH_MS = 500;
const MAX_FLUSH_MS = 15_000;
const MAX_DIRTY_CLIPS = 400_000;

type Clip = { campaign: number; creator: number; v: number; rev: number };
type CreatorRow = { clips: number; earned: number };
type SpendRow = { raw: number; spend: number; exhausted: boolean; paidClips: number };

const pool = makePool(4);
const redis = makeRedis(SVC);
const reader = new GroupReader(redis, STREAMS.clipChanges, GROUP, CONSUMER);

const clips = new Map<number, Clip>();
const byCampaign = new Map<number, number[]>();
const terms = new Map<number, CampaignTerms>();
const lastCreators = new Map<number, Map<number, CreatorRow>>(); // campaign -> creator -> written row
const lastSpend = new Map<number, SpendRow>();

async function loadTerms(ids: number[]) {
  if (ids.length === 0) return;
  const r = await pool.query<{ campaign_id: number; cpm_cents: number; per_clip_cap_cents: number; budget_cents: number }>(
    `SELECT campaign_id, cpm_cents, per_clip_cap_cents, budget_cents FROM api.campaigns WHERE campaign_id = ANY($1::int[])`,
    [ids],
  );
  for (const x of r.rows) terms.set(x.campaign_id, { cpmCents: x.cpm_cents, perClipCapCents: x.per_clip_cap_cents, budgetCents: x.budget_cents });
}

function setClip(id: number, c: Clip) {
  if (!clips.has(id)) {
    let list = byCampaign.get(c.campaign);
    if (!list) byCampaign.set(c.campaign, (list = []));
    list.push(id);
  }
  clips.set(id, c);
}

async function loadState() {
  const cv = await pool.query<{ clip_id: number; campaign_id: number; creator_id: number; v_end: number; rev: number }>(
    `SELECT clip_id, campaign_id, creator_id, v_end, rev FROM earn.clip_values`,
  );
  for (const x of cv.rows) setClip(x.clip_id, { campaign: x.campaign_id, creator: x.creator_id, v: x.v_end, rev: x.rev });
  const cc = await pool.query<{ creator_id: number; campaign_id: number; clips: number; earned_cents: number }>(
    `SELECT creator_id, campaign_id, clips, earned_cents FROM earn.creator_campaign`,
  );
  for (const x of cc.rows) {
    let m = lastCreators.get(x.campaign_id);
    if (!m) lastCreators.set(x.campaign_id, (m = new Map()));
    m.set(x.creator_id, { clips: x.clips, earned: x.earned_cents });
  }
  const sp = await pool.query<{ campaign_id: number; raw_cents: number; spend_cents: number; budget_exhausted: boolean; paid_clips: number }>(
    `SELECT campaign_id, raw_cents, spend_cents, budget_exhausted, paid_clips FROM earn.campaign_spend`,
  );
  for (const x of sp.rows) lastSpend.set(x.campaign_id, { raw: x.raw_cents, spend: x.spend_cents, exhausted: x.budget_exhausted, paidClips: x.paid_clips });
  await loadTerms([...byCampaign.keys()]);
}

const dirtyClips = new Set<number>();
const dirtyCampaigns = new Set<number>();
let pendingIds: string[] = [];

function apply(items: [number, number, number, number, number][]) {
  for (const [rev, clip, campaign, creator, v] of items) {
    const cur = clips.get(clip);
    if (cur && cur.rev >= rev) continue; // duplicate or older delivery
    setClip(clip, { campaign, creator, v, rev });
    dirtyClips.add(clip);
    dirtyCampaigns.add(campaign);
  }
}

async function flush() {
  const t0 = Date.now();
  const missingTerms = [...dirtyCampaigns].filter((c) => !terms.has(c));
  await loadTerms(missingTerms);

  const spendUpserts: [number, SpendRow][] = [];
  const creatorUpserts: [number, number, CreatorRow][] = []; // creator, campaign, row
  const creatorDeletes: [number, number][] = [];
  const nextCreators = new Map<number, Map<number, CreatorRow>>();
  const stillDirty: number[] = [];

  for (const campaign of dirtyCampaigns) {
    const t = terms.get(campaign);
    if (!t) {
      stillDirty.push(campaign); // catalog not visible yet; try again next flush
      continue;
    }
    const ids = byCampaign.get(campaign) ?? [];
    const input = ids.map((id) => {
      const c = clips.get(id)!;
      return { clipId: String(id).padStart(7, '0'), creatorId: String(c.creator), vEnd: c.v };
    });
    const a = allocate(input, t);
    const spend: SpendRow = { raw: a.raw, spend: a.spend, exhausted: a.exhausted, paidClips: a.paidClips };
    const prev = lastSpend.get(campaign);
    if (!prev || prev.raw !== spend.raw || prev.spend !== spend.spend || prev.exhausted !== spend.exhausted || prev.paidClips !== spend.paidClips) {
      spendUpserts.push([campaign, spend]);
    }

    const rows = new Map<number, CreatorRow>();
    for (const c of a.clips) {
      if (c.paid <= 0) continue;
      const creator = Number(c.creatorId);
      const r = rows.get(creator);
      if (r) {
        r.clips++;
        r.earned += c.paid;
      } else rows.set(creator, { clips: 1, earned: c.paid });
    }
    const before = lastCreators.get(campaign) ?? new Map<number, CreatorRow>();
    for (const [creator, r] of rows) {
      const b = before.get(creator);
      if (!b || b.clips !== r.clips || b.earned !== r.earned) creatorUpserts.push([creator, campaign, r]);
    }
    for (const creator of before.keys()) if (!rows.has(creator)) creatorDeletes.push([creator, campaign]);
    nextCreators.set(campaign, rows);
  }

  const dirtyClipRows = [...dirtyClips].map((id) => [id, clips.get(id)!] as const);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (dirtyClipRows.length) {
      await client.query(
        `INSERT INTO earn.clip_values (clip_id, campaign_id, creator_id, v_end, rev)
         SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::bigint[], $5::bigint[])
         ON CONFLICT (clip_id) DO UPDATE SET v_end = EXCLUDED.v_end, rev = EXCLUDED.rev
         WHERE earn.clip_values.rev < EXCLUDED.rev`,
        [
          dirtyClipRows.map(([id]) => id),
          dirtyClipRows.map(([, c]) => c.campaign),
          dirtyClipRows.map(([, c]) => c.creator),
          dirtyClipRows.map(([, c]) => c.v),
          dirtyClipRows.map(([, c]) => c.rev),
        ],
      );
    }
    if (creatorDeletes.length) {
      await client.query(
        `DELETE FROM earn.creator_campaign t USING unnest($1::int[], $2::int[]) AS d(creator_id, campaign_id)
         WHERE t.creator_id = d.creator_id AND t.campaign_id = d.campaign_id`,
        [creatorDeletes.map((d) => d[0]), creatorDeletes.map((d) => d[1])],
      );
    }
    if (creatorUpserts.length) {
      await client.query(
        `INSERT INTO earn.creator_campaign (creator_id, campaign_id, clips, earned_cents)
         SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::bigint[])
         ON CONFLICT (creator_id, campaign_id) DO UPDATE SET clips = EXCLUDED.clips, earned_cents = EXCLUDED.earned_cents`,
        [creatorUpserts.map((u) => u[0]), creatorUpserts.map((u) => u[1]), creatorUpserts.map((u) => u[2].clips), creatorUpserts.map((u) => u[2].earned)],
      );
    }
    if (spendUpserts.length) {
      await client.query(
        `INSERT INTO earn.campaign_spend (campaign_id, raw_cents, spend_cents, budget_exhausted, paid_clips, computed_at)
         SELECT c, r, s, e, p, now() FROM unnest($1::int[], $2::bigint[], $3::bigint[], $4::boolean[], $5::int[]) AS t(c, r, s, e, p)
         ON CONFLICT (campaign_id) DO UPDATE SET raw_cents = EXCLUDED.raw_cents, spend_cents = EXCLUDED.spend_cents,
           budget_exhausted = EXCLUDED.budget_exhausted, paid_clips = EXCLUDED.paid_clips, computed_at = EXCLUDED.computed_at`,
        [
          spendUpserts.map((u) => u[0]),
          spendUpserts.map((u) => u[1].raw),
          spendUpserts.map((u) => u[1].spend),
          spendUpserts.map((u) => u[1].exhausted),
          spendUpserts.map((u) => u[1].paidClips),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    // In-memory state is now ahead of Postgres. Restart and rebuild from Postgres + pending entries.
    log(SVC, 'flush failed, exiting to rebuild state', { error: String(e) });
    process.exit(1);
  }
  client.release();

  await reader.ackAndDelete(pendingIds);
  pendingIds = [];
  for (const [c, rows] of nextCreators) lastCreators.set(c, rows);
  for (const [c, s] of spendUpserts) lastSpend.set(c, s);
  dirtyClips.clear();
  dirtyCampaigns.clear();
  for (const c of stillDirty) dirtyCampaigns.add(c);

  const took = Date.now() - t0;
  return { took, clips: dirtyClipRows.length, campaigns: nextCreators.size, creatorWrites: creatorUpserts.length + creatorDeletes.length };
}

async function main() {
  await retryUntil('postgres', SVC, () => pool.query(EARN_SCHEMA));
  await retryUntil('api.campaigns', SVC, () => pool.query('SELECT 1 FROM api.campaigns LIMIT 1'));
  await loadState();
  await retryUntil('broker', SVC, () => ensureGroup(redis, STREAMS.clipChanges, GROUP));
  log(SVC, 'ready', { clips: clips.size, campaigns: byCampaign.size });

  let flushEvery = MIN_FLUSH_MS;
  let lastFlush = Date.now();
  for (;;) {
    let msgs;
    try {
      msgs = await reader.read(10, 200);
    } catch (e) {
      log(SVC, 'read failed', { error: String(e) });
      await new Promise((r) => setTimeout(r, 1000));
      reader.rewind();
      await retryUntil('broker', SVC, () => ensureGroup(redis, STREAMS.clipChanges, GROUP));
      continue;
    }
    for (const m of msgs) {
      if (m.body?.v === 1 && m.body.type === 'clip_v_end_changed') apply(m.body.items);
      else log(SVC, 'skipping message with unknown contract', { id: m.id });
      pendingIds.push(m.id);
    }
    // Time-based, not "caught up": under load the aggregator publishes one small entry per batch,
    // so earnings is nearly always caught up, and flushing on every entry rewrote ~27k creator rows
    // per second. The interval adapts to the cost of a flush: ~500 ms when quiet, up to 15 s under load.
    const due = Date.now() - lastFlush >= flushEvery;
    if ((pendingIds.length || dirtyCampaigns.size) && (due || dirtyClips.size >= MAX_DIRTY_CLIPS)) {
      const r = await flush();
      lastFlush = Date.now();
      // Spend at most ~12% of the time writing while there is a backlog.
      flushEvery = Math.min(MAX_FLUSH_MS, Math.max(MIN_FLUSH_MS, r.took * 8));
      if (r.took > 1000) log(SVC, 'flush', r);
    }
  }
}

main().catch((e) => {
  log(SVC, 'fatal', { error: String(e) });
  process.exit(1);
});
