// api: every public endpoint except POST /v1/events. Owns the campaign catalog (api schema).
// Reads, never writes, the aggregator (agg), earnings (earn) and classifier (cls) schemas.
// It never computes spend or earnings: it serves what earnings last wrote.
import http from 'node:http';
import { makePool, makeRedis, STREAMS, log, retryUntil } from '../../../shared/src/infra.ts';
import { clipId as fmtClip, creatorId as fmtCreator, campaignId as fmtCampaign } from '../../../shared/src/ids.ts';
import { API_SCHEMA } from '../../../db/schemas.ts';

const SVC = 'api';
const PORT = Number(process.env.PORT ?? 8081);
const HOUR = 3_600_000;
const MAX_BODY = 32 * 1024 * 1024;

const pool = makePool(16);
const redis = makeRedis(SVC);
let dbReady = false;

const CAMPAIGN_RE = /^k_\d{5}$/;
const CREATOR_RE = /^u_\d{6}$/;
const CLIP_RE = /^c_\d{7}$/;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

/** Reads from another service's schema; if that service has never started, treat as empty. */
async function readOther<T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  try {
    return (await pool.query<T>(sql, params)).rows;
  } catch (e: any) {
    if (e?.code === '42P01' || e?.code === '3F000') return []; // undefined table / schema
    throw e;
  }
}
import type pg from 'pg';

const iso = (d: Date | string) => new Date(d).toISOString();
const num = (id: string) => Number(id.slice(2));

// ---- POST /v1/admin/campaigns ---------------------------------------------------------------
async function upsertCampaigns(body: unknown) {
  if (!Array.isArray(body)) throw new HttpError(400, 'expected a JSON array of campaigns');
  const rows = body.map((c: any, i: number) => {
    const intOk = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (!c || typeof c.campaign_id !== 'string' || !CAMPAIGN_RE.test(c.campaign_id)) throw new HttpError(400, `campaign ${i}: bad campaign_id`);
    if (!intOk(c.cpm_cents) || !intOk(c.per_clip_cap_cents) || !intOk(c.budget_cents)) throw new HttpError(400, `campaign ${i}: bad money fields`);
    const end = Date.parse(c.end_at);
    if (!Number.isFinite(end)) throw new HttpError(400, `campaign ${i}: bad end_at`);
    const start = c.start_at ? Date.parse(c.start_at) : NaN;
    return [num(c.campaign_id), String(c.brand ?? ''), c.cpm_cents, c.per_clip_cap_cents, c.budget_cents, Number.isFinite(start) ? new Date(start).toISOString() : null, new Date(end).toISOString()];
  });
  if (rows.length) {
    const col = (k: number) => rows.map((r) => r[k]);
    // Committed before we answer 200, so the aggregator's next catalog lookup sees it.
    await pool.query(
      `INSERT INTO api.campaigns (campaign_id, brand, cpm_cents, per_clip_cap_cents, budget_cents, start_at, end_at)
       SELECT * FROM unnest($1::int[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::timestamptz[], $7::timestamptz[])
       ON CONFLICT (campaign_id) DO UPDATE SET brand = EXCLUDED.brand, cpm_cents = EXCLUDED.cpm_cents,
         per_clip_cap_cents = EXCLUDED.per_clip_cap_cents, budget_cents = EXCLUDED.budget_cents,
         start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at`,
      [col(0), col(1), col(2), col(3), col(4), col(5), col(6)],
    );
  }
  return { upserted: rows.length };
}

// ---- GET /v1/stats ----------------------------------------------------------------------------
async function stats() {
  const r = await readOther<any>(`SELECT distinct_valid_events, late_dropped, dlq_invalid_schema, dlq_unknown_campaign FROM agg.stats WHERE id = 1`, []);
  const s = r[0] ?? { distinct_valid_events: 0, late_dropped: 0, dlq_invalid_schema: 0, dlq_unknown_campaign: 0 };
  return {
    distinct_valid_events: s.distinct_valid_events,
    late_dropped: s.late_dropped,
    dlq_pending: { invalid_schema: s.dlq_invalid_schema, unknown_campaign: s.dlq_unknown_campaign },
  };
}

// ---- POST /v1/dlq/replay ----------------------------------------------------------------------
async function replay(body: any) {
  const reason = body?.reason;
  if (reason !== 'unknown_campaign' && reason !== 'invalid_schema') throw new HttpError(400, 'reason must be unknown_campaign or invalid_schema');
  const s = await stats();
  const replayed = s.dlq_pending[reason as 'unknown_campaign' | 'invalid_schema'];
  // The aggregator owns the DLQ; we hand it the request through the broker.
  await redis.xadd(STREAMS.commands, '*', 'm', JSON.stringify({ v: 1, type: 'dlq_replay', reason, requested_at: new Date().toISOString() }));
  return { replayed };
}

async function campaignRow(campaignId: string) {
  if (!CAMPAIGN_RE.test(campaignId)) return null;
  const r = await pool.query(`SELECT campaign_id, cpm_cents, per_clip_cap_cents, budget_cents, end_at FROM api.campaigns WHERE campaign_id = $1`, [num(campaignId)]);
  return r.rows[0] ?? null;
}

// ---- GET /v1/campaigns/{id}/spend --------------------------------------------------------------
async function spend(campaignId: string) {
  const c = await campaignRow(campaignId);
  if (!c) throw new HttpError(404, 'campaign not registered');
  const s = (await readOther<any>(`SELECT raw_cents, spend_cents, budget_exhausted, paid_clips FROM earn.campaign_spend WHERE campaign_id = $1`, [c.campaign_id]))[0];
  return {
    campaign_id: campaignId,
    budget_cents: c.budget_cents,
    cpm_cents: c.cpm_cents,
    per_clip_cap_cents: c.per_clip_cap_cents,
    end_at: iso(c.end_at),
    raw_earnings_cents: s?.raw_cents ?? 0,
    spend_cents: s?.spend_cents ?? 0,
    budget_exhausted: s?.budget_exhausted ?? false,
    paid_clips: s?.paid_clips ?? 0,
  };
}

// ---- GET /v1/creators/{id}/earnings ------------------------------------------------------------
async function creatorEarnings(creatorId: string) {
  if (!CREATOR_RE.test(creatorId)) return { creator_id: creatorId, total_cents: 0, campaigns: [] };
  const rows = await readOther<{ campaign_id: number; clips: number; earned_cents: number }>(
    `SELECT campaign_id, clips, earned_cents FROM earn.creator_campaign WHERE creator_id = $1 AND earned_cents > 0 ORDER BY campaign_id`,
    [num(creatorId)],
  );
  let total = 0;
  for (const r of rows) total += r.earned_cents;
  return {
    creator_id: creatorId,
    total_cents: total,
    campaigns: rows.map((r) => ({ campaign_id: fmtCampaign(r.campaign_id), clips: r.clips, earned_cents: r.earned_cents })),
  };
}

// ---- GET /v1/campaigns/{id}/top-clips ----------------------------------------------------------
function parseHour(v: string | null, name: string): number {
  if (!v) throw new HttpError(400, `${name} is required`);
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t % HOUR !== 0) throw new HttpError(400, `${name} must be an ISO timestamp on a whole hour`);
  return t;
}

const encodeCursor = (g: number, c: number) => Buffer.from(JSON.stringify({ g, c })).toString('base64url');
function decodeCursor(s: string): { g: number; c: number } {
  try {
    const o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Number.isSafeInteger(o.g) && Number.isSafeInteger(o.c)) return o;
  } catch {}
  throw new HttpError(400, 'bad cursor');
}

// V(clip, t) is the newest accepted snapshot strictly before t: one backward index-only probe
// on the (clip_id, observed_ms) primary key per clip and bound. Keyset pagination on (gained, clip_id).
export const TOP_CLIPS_SQL = `
WITH gained AS (
  SELECT c.clip_id, c.creator_id,
         COALESCE((SELECT s.views FROM agg.snapshots s WHERE s.clip_id = c.clip_id AND s.observed_ms < $3
                   ORDER BY s.observed_ms DESC LIMIT 1), 0)
       - COALESCE((SELECT s.views FROM agg.snapshots s WHERE s.clip_id = c.clip_id AND s.observed_ms < $2
                   ORDER BY s.observed_ms DESC LIMIT 1), 0) AS views_gained
  FROM agg.clips c
  WHERE c.campaign_id = $1
)
SELECT clip_id, creator_id, views_gained FROM gained
WHERE views_gained > 0
  AND ($5::bigint IS NULL OR views_gained < $5 OR (views_gained = $5 AND clip_id > $6))
ORDER BY views_gained DESC, clip_id ASC
LIMIT $4`;

async function topClips(campaignId: string, q: URLSearchParams) {
  const c = await campaignRow(campaignId);
  if (!c) throw new HttpError(404, 'campaign not registered');
  const from = parseHour(q.get('from'), 'from');
  const to = parseHour(q.get('to'), 'to');
  if (to <= from) throw new HttpError(400, 'to must be after from');
  if (to - from > 168 * HOUR) throw new HttpError(400, 'window is longer than 168 hours');
  let limit = 50;
  if (q.has('limit')) {
    const l = q.get('limit')!;
    if (!/^\d+$/.test(l) || Number(l) < 1 || Number(l) > 200) throw new HttpError(400, 'limit must be 1 to 200');
    limit = Number(l);
  }
  const cur = q.get('cursor') ? decodeCursor(q.get('cursor')!) : null;
  const rows = await readOther<{ clip_id: number; creator_id: number; views_gained: number }>(TOP_CLIPS_SQL, [
    c.campaign_id,
    from,
    to,
    limit + 1,
    cur ? cur.g : null,
    cur ? cur.c : null,
  ]);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    campaign_id: campaignId,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    items: page.map((r) => ({ clip_id: fmtClip(r.clip_id), creator_id: fmtCreator(r.creator_id), views_gained: r.views_gained })),
    next_cursor: more && last ? encodeCursor(last.views_gained, last.clip_id) : null,
  };
}

// ---- GET /v1/clips/{id}/relevance --------------------------------------------------------------
async function relevance(clip: string) {
  if (!CLIP_RE.test(clip)) throw new HttpError(404, 'not classified');
  const r = (await readOther<any>(`SELECT clip_id, campaign_id, on_brief, score, model FROM cls.relevance WHERE clip_id = $1`, [num(clip)]))[0];
  if (!r) throw new HttpError(404, 'not classified');
  return { clip_id: clip, campaign_id: fmtCampaign(r.campaign_id), on_brief: r.on_brief, score: Math.round(r.score * 1000) / 1000, model: r.model };
}

// ---- router -----------------------------------------------------------------------------------
async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const m = req.method;
  let match: RegExpExecArray | null;

  if (m === 'GET' && p === '/healthz') return send(res, dbReady && redis.status === 'ready' ? 200 : 503, { ok: dbReady });
  if (m === 'POST' && p === '/v1/admin/campaigns') return send(res, 200, await upsertCampaigns(await readJson(req)));
  if (m === 'GET' && p === '/v1/stats') return send(res, 200, await stats());
  if (m === 'POST' && p === '/v1/dlq/replay') return send(res, 202, await replay(await readJson(req)));
  if (m === 'GET' && (match = /^\/v1\/campaigns\/([^/]+)\/spend$/.exec(p))) return send(res, 200, await spend(decodeURIComponent(match[1])));
  if (m === 'GET' && (match = /^\/v1\/campaigns\/([^/]+)\/top-clips$/.exec(p))) return send(res, 200, await topClips(decodeURIComponent(match[1]), url.searchParams));
  if (m === 'GET' && (match = /^\/v1\/creators\/([^/]+)\/earnings$/.exec(p))) return send(res, 200, await creatorEarnings(decodeURIComponent(match[1])));
  if (m === 'GET' && (match = /^\/v1\/clips\/([^/]+)\/relevance$/.exec(p))) return send(res, 200, await relevance(decodeURIComponent(match[1])));
  send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    log(SVC, 'request error', { error: String(e), url: req.url });
    if (!res.headersSent) send(res, 500, { error: 'internal' });
  });
});
server.keepAliveTimeout = 65_000;

async function main() {
  await retryUntil('postgres', SVC, () => pool.query(API_SCHEMA));
  dbReady = true;
  server.listen(PORT, () => log(SVC, 'listening', { port: PORT }));
}
process.on('SIGTERM', () => server.close(() => process.exit(0)));
main().catch((e) => {
  log(SVC, 'fatal', { error: String(e) });
  process.exit(1);
});
