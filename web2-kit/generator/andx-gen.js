#!/usr/bin/env node
// ANDX view-event generator, sender and checker.
// Node 20+ only, no dependencies.
//
//   node andx-gen.js gen   --preset small|medium|full --seed N --out DIR [--gzip]
//   node andx-gen.js send  --data DIR --url http://localhost:8080 [--rate 15000] [--burst-mult 10]
//                          [--burst-at 0.5] [--burst-secs 60] [--batch 5000] [--concurrency 8]
//                          [--slice START:END] [--file NAME] [--no-burst]
//   node andx-gen.js check --api http://localhost:8081 --expected FILE [--phase final|before_replay] [--perf]
//
// Everything is deterministic for a given (preset, seed).

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Constants shared with the assessment document
// ---------------------------------------------------------------------------
const WINDOW_START_MS = Date.UTC(2026, 0, 5, 0, 0, 0); // 2026-01-05T00:00:00.000Z
const HOUR = 3600 * 1000;
const WINDOW_HOURS = 7 * 24;                           // events are observed inside [start, start + 7 days)
const WINDOW_END_MS = WINDOW_START_MS + WINDOW_HOURS * HOUR;
const LATE_MS = 6 * HOUR;                              // late if emitted_at - observed_at > 6h
const UNKNOWN_CAMPAIGNS = { small: 2, medium: 8, full: 20 };

const PRESETS = {
  small:  { clips: 20000,   creators: 4000,   campaigns: 40 },
  medium: { clips: 150000,  creators: 30000,  campaigns: 300 },
  full:   { clips: 1000000, creators: 200000, campaigns: 2000 },
};

// Pathology rates (also documented in the assessment)
const P_DUPLICATE = 0.015;     // a snapshot is delivered twice (identical payload)
const P_V2 = 0.40;             // share of events in schema v2
const P_MALFORMED = 0.0005;    // a malformed line is inserted after a valid line
const P_UNKNOWN_CAMPAIGN = 0.01; // share of clips belonging to a campaign missing from campaigns.json
const P_REVISION = 0.02;       // clip whose views are revised down once (bot purge)
const P_RESET = 0.003;         // clip whose counter resets close to zero once

// ---------------------------------------------------------------------------
// Deterministic hashing and PRNG
// ---------------------------------------------------------------------------
// murmur3 finaliser: a bijection on 32-bit integers
function fmix32(x) {
  x ^= x >>> 16; x = Math.imul(x, 0x85EBCA6B);
  x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35);
  x ^= x >>> 16;
  return x >>> 0;
}
function hFrom(init, xs) {
  let acc = init;
  for (const x of xs) acc = fmix32((Math.imul(acc ^ fmix32((x | 0) + 0x7F4A7C15), 0x9E3779B1) + 0x632BE5AB) | 0);
  return acc;
}
const h = (...xs) => hFrom(0x9E3779B9, xs);
// 64-bit ids come from two independent 32-bit chains, so a collision needs both to collide
const id64 = (...xs) => hex8(hFrom(0x243F6A88, xs)) + hex8(hFrom(0xB7E15162, xs));
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(r) {
  const u = Math.max(r(), 1e-12), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const hex8 = (n) => n.toString(16).padStart(8, '0');
function eventId(seed, clip, snap) {
  return id64(seed, clip, snap, 0xE1);
}

const pad = (n, w) => String(n).padStart(w, '0');
const clipName = (i) => 'c_' + pad(i, 7);
const creatorName = (i) => 'u_' + pad(i, 6);
const campaignName = (i) => 'k_' + pad(i + 1, 5);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) out[k] = true;
      else { out[k] = nxt; i++; }
    } else out._.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// gen
// ---------------------------------------------------------------------------
const BASE_OFFSETS_H = [1 / 6, 0.5, 1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 30, 36, 42, 48, 54, 60, 66, 72];
const CPMS = [50, 80, 100, 150, 200, 300, 400, 600, 800];
const CAPS = [2000, 5000, 10000, 25000, 50000, 100000];
const BRANDS = ['Nimbus', 'Drift', 'Fuel', 'Kite', 'Orbit', 'Pulse', 'Atlas', 'Ember', 'Vela', 'Quill', 'Rune', 'Sable'];

function buildWorld(preset, seed) {
  const P = PRESETS[preset];
  if (!P) throw new Error('unknown preset ' + preset);
  const K = P.campaigns, U = UNKNOWN_CAMPAIGNS[preset];

  // Campaigns: index 0..K-1 known, K..K+U-1 unknown (published later via campaigns-late.json)
  const camps = [];
  for (let k = 0; k < K + U; k++) {
    const r = rng(h(seed, k, 0xCA));
    const endDays = 3 + Math.floor(r() * 5);                // 3..7 days after window start
    const endHour = Math.min(WINDOW_HOURS, endDays * 24 - Math.floor(r() * 12));
    camps.push({
      campaign_id: campaignName(k),
      brand: BRANDS[k % BRANDS.length] + ' ' + (k + 1),
      cpm_cents: CPMS[Math.floor(r() * CPMS.length)],
      per_clip_cap_cents: CAPS[Math.floor(r() * CAPS.length)],
      budget_cents: 0,
      start_at: new Date(WINDOW_START_MS).toISOString(),
      end_at: new Date(WINDOW_START_MS + endHour * HOUR).toISOString(),
      _endMs: WINDOW_START_MS + endHour * HOUR,
      _budgetFactor: 0.5 + r(),
      _expectedRaw: 0,
    });
  }
  // Zipf-ish campaign popularity
  const cum = new Float64Array(K);
  let s = 0;
  for (let k = 0; k < K; k++) { s += 1 / Math.pow(k + 10, 0.9); cum[k] = s; }
  const pickCampaign = (x) => {
    const target = x * s;
    let lo = 0, hi = K - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
    return lo;
  };

  const C = P.clips;
  const clipCampaign = new Int32Array(C);
  const clipCreator = new Int32Array(C);
  for (let i = 0; i < C; i++) {
    const r = rng(h(seed, i, 0xC1));
    const isUnknown = r() < P_UNKNOWN_CAMPAIGN;
    const k = isUnknown ? K + Math.floor(r() * U) : pickCampaign(r());
    clipCampaign[i] = k;
    clipCreator[i] = Math.floor(P.creators * Math.pow(r(), 1.6));
    const sp = clipSpec(seed, i);
    // rough expected earnings at campaign end, used only to size budgets
    const camp = camps[k];
    const age = (camp._endMs - sp.publishMs) / HOUR;
    if (age > 0) {
      const v = sp.potential * (1 - Math.exp(-age / sp.tau));
      camp._expectedRaw += Math.min(camp.per_clip_cap_cents, Math.floor(v * camp.cpm_cents / 1000));
    }
  }
  for (const c of camps) {
    c.budget_cents = Math.min(200000000, Math.max(10000, Math.round(c._expectedRaw * c._budgetFactor / 100) * 100));
  }
  return { P, K, U, camps, clipCampaign, clipCreator };
}

function clipSpec(seed, i) {
  const r = rng(h(seed, i, 0x5C));
  const publishMs = WINDOW_START_MS + Math.floor(r() * 5 * 24 * HOUR);
  const potential = Math.min(50000000, Math.round(Math.exp(Math.log(3000) + 1.6 * normal(r))));
  const tau = 6 + r() * 30;
  let revisionAt = -1, revisionFactor = 1;
  const x = r();
  if (x < P_RESET) { revisionAt = 3 + Math.floor(r() * 12); revisionFactor = r() * 0.05; }
  else if (x < P_RESET + P_REVISION) { revisionAt = 3 + Math.floor(r() * 12); revisionFactor = 0.3 + r() * 0.6; }
  return { r, publishMs, potential, tau, revisionAt, revisionFactor };
}

// Returns the list of snapshots for clip i: [{snap, obs, views, emit, dupArrival}]
function clipSnapshots(seed, i) {
  const sp = clipSpec(seed, i);
  const r = sp.r;
  const offs = BASE_OFFSETS_H.map((o) => o * (0.9 + r() * 0.2));
  const extra = Math.floor(r() * 5);
  for (let e = 0; e < extra; e++) offs.push(r() * 72);
  offs.sort((a, b) => a - b);
  const out = [];
  let prevObs = -1, prevViews = 0, factor = 1;
  for (let j = 0; j < offs.length; j++) {
    let obs = sp.publishMs + Math.floor(offs[j] * HOUR);
    if (obs <= prevObs) obs = prevObs + 1;
    if (obs >= WINDOW_END_MS) break;
    prevObs = obs;
    const base = sp.potential * (1 - Math.exp(-offs[j] / sp.tau));
    const noise = 1 + 0.02 * normal(r);
    let views;
    if (j === sp.revisionAt) { factor = sp.revisionFactor; views = Math.floor(prevViews * factor); }
    else views = Math.max(prevViews, Math.floor(base * factor * noise));
    if (views < 0) views = 0;
    prevViews = views;
    // emit delay
    const d = r();
    let delay;
    if (d < 0.85) delay = 2000 + r() * 178000;                         // 2s .. 3min
    else if (d < 0.98) delay = 180000 + r() * (2 * HOUR - 180000);      // 3min .. 2h
    else if (d < 0.996) delay = 2 * HOUR + r() * (4 * HOUR - 1000);    // 2h .. 6h-1s (on time)
    else delay = LATE_MS + 1000 + r() * (24 * HOUR);                   // 6h+1s .. 30h (late)
    const emit = obs + Math.floor(delay);
    const dup = r() < P_DUPLICATE ? emit + 1000 + Math.floor(r() * 20 * 60 * 1000) : -1;
    out.push({ snap: j, obs, views, emit, dup });
  }
  return out;
}

const MALFORMED_KINDS = ['truncated', 'missing_creator', 'negative_views', 'string_views', 'bad_version', 'bad_timestamp', 'emitted_before_observed', 'bad_event_id'];

function formatEvent(world, seed, clip, snap, obs, emit, views) {
  const eid = eventId(seed, clip, snap);
  const v2 = (h(seed, clip, snap, 0x5E) % 1000) < P_V2 * 1000;
  const cid = clipName(clip), kid = world.camps[world.clipCampaign[clip]].campaign_id, uid = creatorName(world.clipCreator[clip]);
  if (v2) {
    return `{"v":2,"type":"view_snapshot","event_id":"${eid}","clip_id":"${cid}","campaign_id":"${kid}","creator_id":"${uid}","observed_at_ms":${obs},"emitted_at_ms":${emit},"view_count":${views}}`;
  }
  return `{"v":1,"event_id":"${eid}","clip_id":"${cid}","campaign_id":"${kid}","creator_id":"${uid}","observed_at":"${new Date(obs).toISOString()}","emitted_at":"${new Date(emit).toISOString()}","views":${views}}`;
}

function malformedLine(seed, lineIdx) {
  const kind = MALFORMED_KINDS[h(seed, lineIdx, 0xBAD0) % MALFORMED_KINDS.length];
  const eid = id64(seed, lineIdx, 0xBAD1);
  const obs = WINDOW_START_MS + (h(seed, lineIdx, 0xBAD3) % (WINDOW_HOURS * HOUR));
  const base = { v: 1, event_id: eid, clip_id: 'c_' + pad(h(seed, lineIdx, 0xBAD4) % 1000000, 7), campaign_id: 'k_00001', creator_id: 'u_000001', observed_at: new Date(obs).toISOString(), emitted_at: new Date(obs + 5000).toISOString(), views: 1000 + (h(seed, lineIdx, 0xBAD5) % 100000) };
  switch (kind) {
    case 'truncated': return JSON.stringify(base).slice(0, 40 + (h(seed, lineIdx, 0xBAD6) % 60));
    case 'missing_creator': delete base.creator_id; return JSON.stringify(base);
    case 'negative_views': base.views = -base.views; return JSON.stringify(base);
    case 'string_views': base.views = String(base.views); return JSON.stringify(base);
    case 'bad_version': base.v = 3; return JSON.stringify(base);
    case 'bad_timestamp': base.observed_at = '2026-13-45T25:61:00.000Z'; return JSON.stringify(base);
    case 'emitted_before_observed': base.emitted_at = new Date(obs - 60000).toISOString(); return JSON.stringify(base);
    case 'bad_event_id': base.event_id = eid.toUpperCase().slice(0, 12); return JSON.stringify(base);
  }
}

async function cmdGen(args) {
  const preset = args.preset || 'small';
  const seed = parseInt(args.seed || '7', 10);
  const outDir = args.out || `./data-${preset}-${seed}`;
  const gzip = !!args.gzip;
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const world = buildWorld(preset, seed);
  const clean = (c) => { const o = { ...c }; for (const k of Object.keys(o)) if (k.startsWith('_')) delete o[k]; return o; };
  fs.writeFileSync(path.join(outDir, 'campaigns.json'), JSON.stringify(world.camps.slice(0, world.K).map(clean), null, 1));
  fs.writeFileSync(path.join(outDir, 'campaigns-late.json'), JSON.stringify(world.camps.slice(world.K).map(clean), null, 1));
  log(`world built: ${world.P.clips} clips, ${world.K} campaigns (+${world.U} unknown) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Phase 1: generate compact records into arrival-hour buckets
  const tmp = path.join(outDir, '.tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp);
  const NB = WINDOW_HOURS + 32;
  const bufs = new Array(NB).fill(null).map(() => []);
  const sizes = new Array(NB).fill(0);
  const fds = new Array(NB).fill(-1);
  const flush = (b) => {
    if (!bufs[b].length) return;
    if (fds[b] < 0) fds[b] = fs.openSync(path.join(tmp, 'b' + pad(b, 4)), 'a');
    fs.writeSync(fds[b], bufs[b].join(''));
    bufs[b] = []; sizes[b] = 0;
  };
  const put = (arrival, rec) => {
    let b = Math.floor((arrival - WINDOW_START_MS) / HOUR);
    if (b >= NB) b = NB - 1;
    bufs[b].push(rec); sizes[b] += rec.length;
    if (sizes[b] > 1 << 18) flush(b);
  };
  let snapshots = 0, dups = 0;
  for (let i = 0; i < world.P.clips; i++) {
    for (const s of clipSnapshots(seed, i)) {
      const rel = `${i},${s.snap},${s.obs - WINDOW_START_MS},${s.emit - WINDOW_START_MS},${s.views},`;
      put(s.emit, rel + (s.emit - WINDOW_START_MS) + ',0\n');
      snapshots++;
      if (s.dup >= 0) { put(s.dup, rel + (s.dup - WINDOW_START_MS) + ',1\n'); dups++; }
    }
    if ((i + 1) % 200000 === 0) log(`  phase 1: ${i + 1} clips`);
  }
  for (let b = 0; b < NB; b++) { flush(b); if (fds[b] >= 0) fs.closeSync(fds[b]); }
  log(`phase 1 done: ${snapshots} snapshots, ${dups} duplicate deliveries in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Phase 2: sort each bucket by arrival time and write NDJSON
  const fileName = gzip ? 'events.ndjson.gz' : 'events.ndjson';
  const fileStream = fs.createWriteStream(path.join(outDir, fileName), { highWaterMark: 1 << 22 });
  let sink = fileStream;
  if (gzip) { sink = zlib.createGzip({ level: 4 }); sink.pipe(fileStream); }
  const write = (s) => new Promise((res) => { if (sink.write(s)) res(); else sink.once('drain', res); });
  let lineIdx = 0, malformed = 0;
  for (let b = 0; b < NB; b++) {
    const f = path.join(tmp, 'b' + pad(b, 4));
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.pop();
    const n = lines.length;
    const clip = new Int32Array(n), snap = new Int32Array(n), obs = new Float64Array(n), emit = new Float64Array(n), views = new Float64Array(n), arr = new Float64Array(n), dupf = new Uint8Array(n);
    for (let j = 0; j < n; j++) {
      const p = lines[j].split(',');
      clip[j] = +p[0]; snap[j] = +p[1]; obs[j] = +p[2]; emit[j] = +p[3]; views[j] = +p[4]; arr[j] = +p[5]; dupf[j] = +p[6];
    }
    const idx = new Uint32Array(n);
    for (let j = 0; j < n; j++) idx[j] = j;
    const order = Array.from(idx).sort((x, y) => (arr[x] - arr[y]) || (clip[x] - clip[y]) || (snap[x] - snap[y]) || (dupf[x] - dupf[y]));
    let chunk = [];
    let chunkLen = 0;
    for (const j of order) {
      const line = formatEvent(world, seed, clip[j], snap[j], obs[j] + WINDOW_START_MS, emit[j] + WINDOW_START_MS, views[j]);
      chunk.push(line, '\n'); chunkLen += line.length;
      lineIdx++;
      if ((h(seed, lineIdx, 0xBAD) % 100000) < P_MALFORMED * 100000) {
        const m = malformedLine(seed, lineIdx);
        chunk.push(m, '\n'); chunkLen += m.length; lineIdx++; malformed++;
      }
      if (chunkLen > 1 << 20) { await write(chunk.join('')); chunk = []; chunkLen = 0; }
    }
    if (chunk.length) await write(chunk.join(''));
    fs.unlinkSync(f);
  }
  await new Promise((res) => { sink.end(); fileStream.on('finish', res); });
  fs.rmSync(tmp, { recursive: true, force: true });
  const bytes = fs.statSync(path.join(outDir, fileName)).size;
  const manifest = { preset, seed, file: fileName, lines: lineIdx, bytes, clips: world.P.clips, creators: world.P.creators, campaigns: world.K, unknown_campaigns: world.U, generated_in_s: +((Date.now() - t0) / 1000).toFixed(1) };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  log(`done: ${lineIdx} lines (${malformed} malformed), ${(bytes / 1e6).toFixed(1)} MB, ${manifest.generated_in_s}s -> ${outDir}`);
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------
async function cmdSend(args) {
  const dir = args.data;
  if (!dir) throw new Error('--data DIR required');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const file = path.join(dir, args.file || manifest.file);
  const url = (args.url || 'http://localhost:8080').replace(/\/$/, '') + '/v1/events';
  const rate = parseFloat(args.rate || '15000');
  const burstMult = args['no-burst'] ? 1 : parseFloat(args['burst-mult'] || '10');
  const burstAt = parseFloat(args['burst-at'] || '0.5');
  const burstSecs = parseFloat(args['burst-secs'] || '60');
  const batchSize = parseInt(args.batch || '5000', 10);
  const conc = parseInt(args.concurrency || '8', 10);
  let [sliceStart, sliceEnd] = [0, Infinity];
  if (args.slice) { const [a, b] = String(args.slice).split(':'); sliceStart = parseInt(a || '0', 10); sliceEnd = b ? parseInt(b, 10) : Infinity; }
  const totalLines = args.file ? Infinity : manifest.lines;
  const burstLine = Math.floor(Math.min(totalLines, sliceEnd) * burstAt);

  const st = { sent: 0, accepted: 0, rejected: 0, retries: 0, throttled: 0, t0: Date.now(), burstStart: 0, burstEnd: 0 };
  let tokens = 0, lastRefill = Date.now();
  const currentRate = () => (st.burstStart && !st.burstEnd ? rate * burstMult : rate);
  async function takeTokens(n) {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(tokens + ((now - lastRefill) / 1000) * currentRate(), currentRate());
      lastRefill = now;
      if (tokens >= n || tokens >= currentRate()) { tokens -= n; return; }
      await sleep(Math.max(1, ((n - tokens) / currentRate()) * 1000));
    }
  }
  async function post(body, count) {
    let backoff = 250;
    for (;;) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body, signal: ctrl.signal });
        clearTimeout(timer);
        if (res.status === 200 || res.status === 202) {
          const j = await res.json().catch(() => ({}));
          st.accepted += j.accepted ?? 0; st.rejected += j.rejected ?? 0; st.sent += count;
          return;
        }
        if (res.status === 429 || res.status === 503) {
          st.throttled++;
          const ra = parseFloat(res.headers.get('retry-after') || '1');
          await res.arrayBuffer().catch(() => {});
          await sleep(Math.min(30, Math.max(0.05, ra)) * 1000);
          continue;
        }
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      } catch (e) {
        if (String(e.message).startsWith('HTTP 4')) throw e;
        st.retries++;
        await sleep(backoff);
        backoff = Math.min(5000, backoff * 2);
      }
    }
  }
  const inflight = new Set();
  let batch = [], lineNo = 0;
  const report = setInterval(() => {
    const secs = (Date.now() - st.t0) / 1000;
    log(`sent ${st.sent} lines (${(st.sent / secs).toFixed(0)}/s), accepted ${st.accepted}, rejected ${st.rejected}, throttled ${st.throttled}, retries ${st.retries}${st.burstStart && !st.burstEnd ? ' [BURST]' : ''}`);
  }, 5000);
  const dispatch = async (lines) => {
    await takeTokens(lines.length);
    while (inflight.size >= conc) await Promise.race(inflight);
    const p = post(lines.join('\n') + '\n', lines.length).finally(() => inflight.delete(p));
    inflight.add(p);
  };
  for await (const line of readLines(file)) {
    const i = lineNo++;
    if (i < sliceStart) continue;
    if (i >= sliceEnd) break;
    if (!line) continue;
    if (burstMult > 1 && !st.burstStart && i >= burstLine) { st.burstStart = Date.now(); log('burst started'); }
    if (st.burstStart && !st.burstEnd && Date.now() - st.burstStart > burstSecs * 1000) { st.burstEnd = Date.now(); log('burst ended'); }
    batch.push(line);
    if (batch.length >= batchSize) { await dispatch(batch); batch = []; }
  }
  if (batch.length) await dispatch(batch);
  await Promise.all(inflight);
  clearInterval(report);
  const secs = (Date.now() - st.t0) / 1000;
  log(`send finished: ${st.sent} lines in ${secs.toFixed(1)}s (${(st.sent / secs).toFixed(0)}/s), accepted ${st.accepted}, rejected ${st.rejected}, throttled ${st.throttled}, retries ${st.retries}`);
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
async function cmdCheck(args) {
  const api = (args.api || 'http://localhost:8081').replace(/\/$/, '');
  const exp = JSON.parse(fs.readFileSync(args.expected, 'utf8'));
  const phase = args.phase || 'final';
  const E = exp[phase];
  if (!E) throw new Error('phase not found in expected file: ' + phase);
  const perf = !!args.perf;
  let failures = 0, checks = 0, failedChecks = 0, lastFailedCheck = -1;
  const fail = (msg) => {
    failures++;
    if (lastFailedCheck !== checks) { failedChecks++; lastFailedCheck = checks; }
    if (failures <= 25) console.log('  FAIL ' + msg);
  };
  const timings = { stats: [], spend: [], earnings: [], top: [] };
  const get = async (p, bucket) => {
    const t = performance.now();
    const res = await fetch(api + p);
    const body = res.status === 200 ? await res.json() : await res.text();
    if (bucket) timings[bucket].push(performance.now() - t);
    return { status: res.status, body };
  };

  // stats
  const s = await get('/v1/stats', 'stats');
  checks++;
  if (s.status !== 200) fail(`/v1/stats -> ${s.status}`);
  else {
    // field by field: key order and extra fields in the response are ignored
    for (const k of ['distinct_valid_events', 'late_dropped']) {
      if (s.body[k] !== E.stats[k]) fail(`stats.${k}: expected ${E.stats[k]}, got ${s.body[k]}`);
    }
    for (const k of ['invalid_schema', 'unknown_campaign']) {
      const got = s.body.dlq_pending ? s.body.dlq_pending[k] : undefined;
      if (got !== E.stats.dlq_pending[k]) fail(`stats.dlq_pending.${k}: expected ${E.stats.dlq_pending[k]}, got ${got}`);
    }
  }
  console.log(`stats checked`);

  // spend
  if (E.spend) {
    for (const want of E.spend) {
      checks++;
      const r = await get(`/v1/campaigns/${want.campaign_id}/spend`, 'spend');
      if (r.status !== 200) { fail(`spend ${want.campaign_id} -> ${r.status}`); continue; }
      for (const k of ['budget_cents', 'raw_earnings_cents', 'spend_cents', 'budget_exhausted', 'paid_clips']) {
        if (r.body[k] !== want[k]) fail(`spend ${want.campaign_id}.${k}: expected ${want[k]}, got ${r.body[k]}`);
      }
    }
    console.log(`spend checked for ${E.spend.length} campaigns`);
  }

  // creator earnings
  if (E.earnings) {
    for (const want of E.earnings) {
      checks++;
      const r = await get(`/v1/creators/${want.creator_id}/earnings`, 'earnings');
      if (r.status !== 200) { fail(`earnings ${want.creator_id} -> ${r.status}`); continue; }
      if (r.body.total_cents !== want.total_cents) fail(`earnings ${want.creator_id}.total_cents: expected ${want.total_cents}, got ${r.body.total_cents}`);
      const list = Array.isArray(r.body.campaigns) ? r.body.campaigns : null;
      if (!list || list.length !== want.campaigns.length) { fail(`earnings ${want.creator_id}.campaigns: expected ${want.campaigns.length} entries, got ${list ? list.length : 'none'}`); continue; }
      for (let i = 0; i < list.length; i++) {
        for (const k of ['campaign_id', 'clips', 'earned_cents']) {
          if (list[i][k] !== want.campaigns[i][k]) { fail(`earnings ${want.creator_id}.campaigns[${i}].${k}: expected ${want.campaigns[i][k]}, got ${list[i][k]}`); break; }
        }
      }
    }
    console.log(`earnings checked for ${E.earnings.length} creators`);
  }

  // top clips (2 pages of 50 via cursor)
  if (E.top) {
    for (const q of E.top) {
      checks++;
      const base = `/v1/campaigns/${q.campaign_id}/top-clips?from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}&limit=50`;
      const p1 = await get(base, 'top');
      if (p1.status !== 200) { fail(`top ${q.campaign_id} -> ${p1.status}`); continue; }
      let items = p1.body.items || [];
      if (p1.body.next_cursor) {
        const p2 = await get(base + '&cursor=' + encodeURIComponent(p1.body.next_cursor), 'top');
        if (p2.status !== 200) { fail(`top page 2 ${q.campaign_id} -> ${p2.status}`); continue; }
        items = items.concat(p2.body.items || []);
      }
      const want = q.items;
      const got = items.slice(0, want.length).map((x) => [x.clip_id, x.creator_id, x.views_gained]);
      if (JSON.stringify(got) !== JSON.stringify(want.map((x) => [x.clip_id, x.creator_id, x.views_gained]))) fail(`top ${q.campaign_id} ${q.from}..${q.to}: first ${want.length} items differ`);
      if (q.total <= 50 && p1.body.next_cursor) fail(`top ${q.campaign_id}: next_cursor should be null when all ${q.total} items fit on page 1`);
    }
    console.log(`top-clips checked for ${E.top.length} queries`);
  }

  console.log(`\n${checks - failedChecks} of ${checks} checks passed, ${failures} failures`);

  if (perf) {
    const p95 = (a) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * 0.95))]; };
    // extra sequential sampling for latency
    const camps = (E.spend || []).map((x) => x.campaign_id);
    const creators = (E.earnings || []).map((x) => x.creator_id);
    for (let i = 0; i < 200 && camps.length; i++) await get(`/v1/campaigns/${camps[i % camps.length]}/spend`, 'spend');
    for (let i = 0; i < 200 && creators.length; i++) await get(`/v1/creators/${creators[i % creators.length]}/earnings`, 'earnings');
    for (let i = 0; i < 200 && E.top && E.top.length; i++) { const q = E.top[i % E.top.length]; await get(`/v1/campaigns/${q.campaign_id}/top-clips?from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}&limit=50`, 'top'); }
    for (let i = 0; i < 50; i++) await get('/v1/stats', 'stats');
    console.log('\nlatency p95 (ms): ' + Object.entries(timings).map(([k, v]) => `${k}=${p95(v).toFixed(1)} (n=${v.length})`).join(', '));
  }
  process.exitCode = failures ? 1 : 0;
}

// Streams lines from a plain or gzipped file. Safe to await inside the consuming loop.
async function* readLines(file) {
  let input = fs.createReadStream(file, { highWaterMark: 1 << 22 });
  if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  const dec = new (require('string_decoder').StringDecoder)('utf8');
  let rest = '';
  for await (const chunk of input) {
    const parts = (rest + dec.write(chunk)).split('\n');
    rest = parts.pop();
    for (const l of parts) yield l.endsWith('\r') ? l.slice(0, -1) : l;
  }
  rest += dec.end();
  if (rest) yield rest;
}

// ---------------------------------------------------------------------------
function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const fn = { gen: cmdGen, send: cmdSend, check: cmdCheck }[cmd];
  if (!fn) {
    console.log('usage: node andx-gen.js gen|send|check [options]  (see README.md)');
    process.exit(2);
  }
  fn(args).catch((e) => { console.error(e.stack || e); process.exit(1); });
}

module.exports = { WINDOW_START_MS, WINDOW_END_MS, HOUR, LATE_MS, PRESETS, h, hex8, id64 };
