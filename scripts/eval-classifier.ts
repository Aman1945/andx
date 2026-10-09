// Evaluates the classifier on web2-kit/ai/dev.jsonl and prints precision, recall, F1, errors and latency.
// Usage: node scripts/eval-classifier.ts            (rules + heuristic)
//        LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... node scripts/eval-classifier.ts
import fs from 'node:fs';
import { classifyClip, guard } from '../services/classifier/src/model.ts';

const rows = fs
  .readFileSync(new URL('../web2-kit/ai/dev.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

let tp = 0, fp = 0, fn = 0, tn = 0;
const lat: number[] = [];
const errors: string[] = [];
let guarded = 0;
for (const r of rows) {
  const clip = { clipId: r.clip_id, campaignId: r.campaign_id, caption: r.caption, transcript: r.transcript };
  if (guard(clip).decided) guarded++;
  const t = performance.now();
  const v = await classifyClip(clip, { timeoutMs: 5000 });
  lat.push(performance.now() - t);
  const y = r.label === 1;
  if (v.onBrief && y) tp++;
  else if (v.onBrief && !y) fp++;
  else if (!v.onBrief && y) fn++;
  else tn++;
  if (v.onBrief !== y) errors.push(`${r.clip_id} label=${r.label} pred=${v.onBrief ? 1 : 0} (${v.reason}) ${r.caption.slice(0, 60)} | ${r.transcript.slice(0, 80)}`);
}
const p = tp / Math.max(1, tp + fp);
const rcl = tp / Math.max(1, tp + fn);
const f1 = (2 * p * rcl) / Math.max(1e-9, p + rcl);
lat.sort((a, b) => a - b);
console.log(`n=${rows.length} tp=${tp} fp=${fp} fn=${fn} tn=${tn}`);
console.log(`precision=${p.toFixed(3)} recall=${rcl.toFixed(3)} f1=${f1.toFixed(3)} decided_by_guards=${guarded}`);
console.log(`p95 latency ms=${lat[Math.floor(lat.length * 0.95)].toFixed(1)}`);
console.log('errors:\n  ' + errors.join('\n  '));
