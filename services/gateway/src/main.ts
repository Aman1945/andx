// gateway: POST /v1/events. Validates every line, applies lag-driven backpressure, and
// publishes each request to the broker in one atomic MULTI. It answers 202 only after
// Redis has acknowledged the write (AOF appendfsync always), so a 202 is never lost.
import http from 'node:http';
import { parseLine } from '../../../shared/src/validate.ts';
import { clipNum, campaignNum, creatorNum } from '../../../shared/src/ids.ts';
import { makeRedis, STREAMS, log } from '../../../shared/src/infra.ts';

const SVC = 'gateway';
const PORT = Number(process.env.PORT ?? 8080);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 10_000;

// Backpressure thresholds, in unprocessed broker entries (one entry = one request, <= 10k lines).
// Consumers XDEL what they have acked, so XLEN is the backlog. See README "Backpressure".
const HIGH_ENTRIES = Number(process.env.BP_HIGH_ENTRIES ?? 60); // ~300k lines at 5k/request
const LOW_ENTRIES = Number(process.env.BP_LOW_ENTRIES ?? 30);
const TEXT_HIGH_ENTRIES = Number(process.env.BP_TEXT_HIGH_ENTRIES ?? 200);
const MEM_HIGH_BYTES = Number(process.env.BP_MEM_HIGH_BYTES ?? 1_300_000_000); // broker maxmemory is 1800mb
const PUBLISH_TIMEOUT_MS = 5000;

const redis = makeRedis(SVC);

const lag = { views: 0, text: 0, mem: 0, at: 0, ok: false };
let throttled = false;

async function pollLag() {
  try {
    const res = await redis.pipeline().xlen(STREAMS.views).xlen(STREAMS.text).info('memory').exec();
    if (!res) throw new Error('no reply');
    lag.views = Number(res[0][1]);
    lag.text = Number(res[1][1]);
    const m = /used_memory:(\d+)/.exec(String(res[2][1]));
    lag.mem = m ? Number(m[1]) : 0;
    lag.at = Date.now();
    lag.ok = true;
  } catch {
    lag.ok = false;
  }
  if (lag.views >= HIGH_ENTRIES || lag.text >= TEXT_HIGH_ENTRIES || lag.mem >= MEM_HIGH_BYTES) throttled = true;
  else if (lag.views <= LOW_ENTRIES && lag.mem < MEM_HIGH_BYTES * 0.8) throttled = false;
}
setInterval(pollLag, 200).unref();

/** null when we may accept, otherwise the status and Retry-After to send. */
function backpressure(): { status: number; retryAfter: number; reason: string } | null {
  if (redis.status !== 'ready' || !lag.ok || Date.now() - lag.at > 2000) return { status: 503, retryAfter: 2, reason: 'broker_unavailable' };
  if (throttled) return { status: 429, retryAfter: 1, reason: 'consumer_lag' };
  return null;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers });
  res.end(s);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('publish timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function handleEvents(req: http.IncomingMessage, res: http.ServerResponse) {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BYTES) {
    send(res, 413, { error: 'body too large' }, { connection: 'close' });
    req.destroy();
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      tooBig = true;
      break;
    }
    chunks.push(chunk);
  }
  if (tooBig) {
    send(res, 413, { error: 'body too large' }, { connection: 'close' });
    req.destroy();
    return;
  }

  const bp = backpressure();
  if (bp) {
    send(res, bp.status, { error: bp.reason }, { 'retry-after': String(bp.retryAfter) });
    return;
  }

  const lines = Buffer.concat(chunks).toString('utf8').split('\n');
  let nonEmpty = 0;
  for (const l of lines) if (l.length > 0 && l !== '\r') nonEmpty++;
  if (nonEmpty > MAX_LINES) {
    send(res, 413, { error: `more than ${MAX_LINES} lines` });
    return;
  }

  const views: unknown[] = [];
  const invalid: unknown[] = [];
  const texts: unknown[] = [];
  for (const l of lines) {
    const p = parseLine(l);
    if (!p) continue;
    if (p.kind === 'view') {
      views.push([p.eventId, clipNum(p.clipId), campaignNum(p.campaignId), creatorNum(p.creatorId), p.observedMs, p.emittedMs, p.views]);
    } else if (p.kind === 'text') {
      texts.push([p.eventId, clipNum(p.clipId), campaignNum(p.campaignId), p.caption, p.transcript]);
    } else {
      invalid.push([p.identity, p.raw]);
    }
  }

  if (views.length || invalid.length || texts.length) {
    const multi = redis.multi();
    if (views.length || invalid.length) {
      multi.xadd(STREAMS.views, '*', 'm', JSON.stringify({ v: 1, type: 'ingest_batch', views, invalid }));
    }
    if (texts.length) {
      multi.xadd(STREAMS.text, '*', 'm', JSON.stringify({ v: 1, type: 'clip_text_batch', items: texts }));
    }
    try {
      const out = await withTimeout(multi.exec(), PUBLISH_TIMEOUT_MS);
      if (!out || out.some(([err]) => err)) throw new Error('exec failed');
    } catch (e) {
      // Not acknowledged by the broker: tell the sender to retry. A late write is harmless (dedup).
      log(SVC, 'publish failed', { error: String(e) });
      send(res, 503, { error: 'broker_write_failed' }, { 'retry-after': '1' });
      return;
    }
  }

  send(res, 202, { accepted: views.length + texts.length, rejected: invalid.length });
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (req.method === 'GET' && url === '/healthz') {
    const ok = redis.status === 'ready';
    send(res, ok ? 200 : 503, { ok });
    return;
  }
  if (req.method === 'POST' && url === '/v1/events') {
    handleEvents(req, res).catch((e) => {
      log(SVC, 'request error', { error: String(e) });
      if (!res.headersSent) send(res, 503, { error: 'internal' }, { 'retry-after': '1' });
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});
server.keepAliveTimeout = 65_000;
server.requestTimeout = 60_000;

server.listen(PORT, () => log(SVC, 'listening', { port: PORT }));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
