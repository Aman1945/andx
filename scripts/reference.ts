// Independent single-process reference: reads a generated data folder and computes the expected
// stats, spend for every campaign and earnings for a sample of creators, in the checker's format.
// Used to verify the pipeline on presets that have no expected file (medium). Not part of the system.
// Usage: node scripts/reference.ts ./data-medium > expected-medium.json
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';
import { parseLine, LATE_MS } from '../shared/src/validate.ts';
import { allocate } from '../shared/src/money.ts';

const dir = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const camps = JSON.parse(fs.readFileSync(path.join(dir, 'campaigns.json'), 'utf8'));
const late = JSON.parse(fs.readFileSync(path.join(dir, 'campaigns-late.json'), 'utf8'));
const early = new Set(camps.map((c: any) => c.campaign_id));
const all = [...camps, ...late];
const byId = new Map(all.map((c: any) => [c.campaign_id, c]));

const seenAcc = new Set<string>();
const seenLate = new Set<string>();
const invalid = new Set<string>();
let acceptedEarly = 0;
let unknownBefore = 0;
// clip -> [campaign, creator, best observed before end, views at that observation]
const clipBest = new Map<string, [string, string, number, number]>();

const file = path.join(dir, manifest.file);
let input: NodeJS.ReadableStream = fs.createReadStream(file);
if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
const rl = readline.createInterface({ input, crlfDelay: Infinity });
for await (const line of rl) {
  const p = parseLine(line);
  if (!p) continue;
  if (p.kind === 'invalid') {
    invalid.add(p.identity);
    continue;
  }
  if (p.kind !== 'view') continue;
  if (p.emittedMs - p.observedMs > LATE_MS) {
    seenLate.add(p.eventId);
    continue;
  }
  if (seenAcc.has(p.eventId)) continue;
  seenAcc.add(p.eventId);
  if (early.has(p.campaignId)) acceptedEarly++;
  else unknownBefore++;
  const c = byId.get(p.campaignId);
  if (!c) continue;
  const end = Date.parse(c.end_at);
  if (p.observedMs >= end) {
    if (!clipBest.has(p.clipId)) clipBest.set(p.clipId, [p.campaignId, p.creatorId, -1, 0]);
    continue;
  }
  const cur = clipBest.get(p.clipId);
  if (!cur || p.observedMs > cur[2]) clipBest.set(p.clipId, [p.campaignId, p.creatorId, p.observedMs, p.views]);
}

const perCampaign = new Map<string, { clipId: string; creatorId: string; vEnd: number }[]>();
for (const [clip, [camp, creator, obs, v]] of clipBest) {
  if (!perCampaign.has(camp)) perCampaign.set(camp, []);
  perCampaign.get(camp)!.push({ clipId: clip, creatorId: creator, vEnd: obs >= 0 ? v : 0 });
}
const spend = [];
const creators = new Map<string, Map<string, { clips: number; earned: number }>>();
for (const c of all) {
  const a = allocate(perCampaign.get(c.campaign_id) ?? [], { cpmCents: c.cpm_cents, perClipCapCents: c.per_clip_cap_cents, budgetCents: c.budget_cents });
  spend.push({ campaign_id: c.campaign_id, budget_cents: c.budget_cents, raw_earnings_cents: a.raw, spend_cents: a.spend, budget_exhausted: a.exhausted, paid_clips: a.paidClips });
  for (const x of a.clips) {
    if (x.paid <= 0) continue;
    if (!creators.has(x.creatorId)) creators.set(x.creatorId, new Map());
    const m = creators.get(x.creatorId)!;
    const r = m.get(c.campaign_id) ?? { clips: 0, earned: 0 };
    r.clips++;
    r.earned += x.paid;
    m.set(c.campaign_id, r);
  }
}
const sample = [...creators.keys()].sort().filter((_, i) => i % 97 === 0).slice(0, 300);
const earnings = sample.map((id) => {
  const m = creators.get(id)!;
  const list = [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([campaign_id, r]) => ({ campaign_id, clips: r.clips, earned_cents: r.earned }));
  return { creator_id: id, total_cents: list.reduce((s, x) => s + x.earned_cents, 0), campaigns: list };
});

console.log(
  JSON.stringify({
    meta: { preset: manifest.preset, seed: manifest.seed, source: 'scripts/reference.ts' },
    before_replay: { stats: { distinct_valid_events: acceptedEarly, late_dropped: seenLate.size, dlq_pending: { invalid_schema: invalid.size, unknown_campaign: unknownBefore } } },
    final: { stats: { distinct_valid_events: acceptedEarly + unknownBefore, late_dropped: seenLate.size, dlq_pending: { invalid_schema: invalid.size, unknown_campaign: 0 } }, spend, earnings },
  }),
);
