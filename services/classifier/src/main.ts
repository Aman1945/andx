// classifier: consumes ingest.text (clip_text events), classifies each clip against its campaign
// brief, and stores the result in cls.relevance. Results are idempotent per clip_id, so a
// re-delivered batch just rewrites the same rows.
import { classifyClip, llmEnabled, llmConfig } from './model.ts';
import { makePool, makeRedis, STREAMS, GroupReader, ensureGroup, log, retryUntil, sleep } from '../../../shared/src/infra.ts';
import { campaignId as fmtCampaign, clipId as fmtClip } from '../../../shared/src/ids.ts';
import { CLS_SCHEMA } from '../../../db/schemas.ts';

const SVC = 'classifier';
const GROUP = 'classifier';
const CONCURRENCY = Number(process.env.CLS_CONCURRENCY ?? 16);

const pool = makePool(4);
const redis = makeRedis(SVC);
const reader = new GroupReader(redis, STREAMS.text, GROUP, 'classifier-1');

// [event_id, clip, campaign, caption, transcript]
type TextItem = [string, number, number, string, string];

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function handle(items: TextItem[]) {
  // Same clip twice in a batch: keep the last event.
  const byClip = new Map<number, TextItem>();
  for (const it of items) byClip.set(it[1], it);
  const uniq = [...byClip.values()];
  const verdicts = await mapLimit(uniq, CONCURRENCY, (it) =>
    classifyClip({ clipId: fmtClip(it[1]), campaignId: fmtCampaign(it[2]), caption: it[3], transcript: it[4] }),
  );
  await pool.query(
    `INSERT INTO cls.relevance (clip_id, campaign_id, event_id, on_brief, score, model)
     SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::boolean[], $5::real[], $6::text[])
     ON CONFLICT (clip_id) DO UPDATE SET campaign_id = EXCLUDED.campaign_id, event_id = EXCLUDED.event_id,
       on_brief = EXCLUDED.on_brief, score = EXCLUDED.score, model = EXCLUDED.model, classified_at = now()`,
    [uniq.map((u) => u[1]), uniq.map((u) => u[2]), uniq.map((u) => u[0]), verdicts.map((v) => v.onBrief), verdicts.map((v) => v.score), verdicts.map((v) => v.model)],
  );
}

async function main() {
  await retryUntil('postgres', SVC, () => pool.query(CLS_SCHEMA));
  await retryUntil('broker', SVC, () => ensureGroup(redis, STREAMS.text, GROUP));
  log(SVC, 'ready', { llm: llmEnabled() ? llmConfig.model : 'disabled (rules only)' });
  for (;;) {
    try {
      const msgs = await reader.read(10, 1000);
      if (!msgs.length) continue;
      const items: TextItem[] = [];
      for (const m of msgs) {
        if (m.body?.v === 1 && m.body.type === 'clip_text_batch') items.push(...m.body.items);
        else log(SVC, 'skipping message with unknown contract', { id: m.id });
      }
      if (items.length) await handle(items);
      await reader.ackAndDelete(msgs.map((m) => m.id));
    } catch (e) {
      log(SVC, 'batch failed, retrying', { error: String(e) });
      reader.rewind();
      await sleep(1000);
      await retryUntil('broker', SVC, () => ensureGroup(redis, STREAMS.text, GROUP));
    }
  }
}

main().catch((e) => {
  log(SVC, 'fatal', { error: String(e) });
  process.exit(1);
});
