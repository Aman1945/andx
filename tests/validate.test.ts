import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, classify, parseIsoMs, LATE_MS } from '../shared/src/validate.ts';

const v1 = {
  v: 1,
  event_id: '7c5424d0e71521d4',
  clip_id: 'c_0010277',
  campaign_id: 'k_00015',
  creator_id: 'u_000814',
  observed_at: '2026-01-05T00:10:43.558Z',
  emitted_at: '2026-01-05T00:11:23.203Z',
  views: 10,
};
const v2 = {
  v: 2,
  type: 'view_snapshot',
  event_id: '0d9a51f2c37be801',
  clip_id: 'c_0004712',
  campaign_id: 'k_00015',
  creator_id: 'u_002513',
  observed_at_ms: 1767572203558,
  emitted_at_ms: 1767572283203,
  view_count: 3150,
};
const line = (o: unknown) => JSON.stringify(o);

test('valid v1 and v2 snapshots normalize to the same shape', () => {
  const a = parseLine(line(v1));
  assert.equal(a?.kind, 'view');
  if (a?.kind === 'view') {
    assert.equal(a.views, 10);
    assert.equal(a.observedMs, Date.parse(v1.observed_at));
  }
  const b = parseLine(line(v2));
  assert.equal(b?.kind, 'view');
  if (b?.kind === 'view') assert.equal(b.views, 3150);
});

test('trailing CR is ignored and empty lines are skipped', () => {
  assert.equal(parseLine(line(v1) + '\r')?.kind, 'view');
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('\r'), null);
});

test('clip_text is valid only on v2', () => {
  const t = { v: 2, type: 'clip_text', event_id: '5be0c2a1d4f79e13', clip_id: 'c_8000001', campaign_id: 'k_00007', caption: 'x', transcript: 'y' };
  assert.equal(parseLine(line(t))?.kind, 'text');
  assert.equal(parseLine(line({ ...t, v: 1 }))?.kind, 'invalid');
  assert.equal(parseLine(line({ ...t, caption: 'a'.repeat(5001) }))?.kind, 'invalid');
});

const invalidCases: Array<[string, unknown]> = [
  ['truncated JSON', null],
  ['array', [1, 2]],
  ['null', null],
  ['bad version', { ...v1, v: 3 }],
  ['version as string', { ...v1, v: '1' }],
  ['uppercase event id', { ...v1, event_id: '7C5424D0E71521D4' }],
  ['short event id', { ...v1, event_id: '7c5424d0e715' }],
  ['v1 with wrong type', { ...v1, type: 'clip_text' }],
  ['v2 without type', (({ type, ...r }) => r)(v2)],
  ['bad clip id', { ...v1, clip_id: 'c_123' }],
  ['bad campaign id', { ...v1, campaign_id: 'k_1' }],
  ['missing creator', (({ creator_id, ...r }) => r)(v1)],
  ['negative views', { ...v1, views: -5 }],
  ['string views', { ...v1, views: '10' }],
  ['fractional views', { ...v1, views: 1.5 }],
  ['views over 2e9', { ...v1, views: 2_000_000_001 }],
  ['impossible timestamp', { ...v1, observed_at: '2026-13-45T25:61:00.000Z' }],
  ['Feb 30', { ...v1, observed_at: '2026-02-30T00:00:00.000Z' }],
  ['no milliseconds', { ...v1, observed_at: '2026-01-05T00:10:43Z' }],
  ['before 2020', { ...v1, observed_at: '2019-12-31T23:59:59.999Z', emitted_at: '2019-12-31T23:59:59.999Z' }],
  ['emitted before observed', { ...v1, emitted_at: '2026-01-05T00:10:43.557Z' }],
  ['v2 string timestamp', { ...v2, observed_at_ms: '1767572203558' }],
];

for (const [name, obj] of invalidCases) {
  test(`invalid: ${name}`, () => {
    const raw = name === 'truncated JSON' ? line(v1).slice(0, 50) : line(obj);
    assert.equal(parseLine(raw)?.kind, 'invalid');
  });
}

test('malformed identity uses event_id when present, else a hash of the line', () => {
  const a = parseLine(line({ ...v1, views: -1 }));
  const b = parseLine(line({ ...v1, views: -2 }));
  assert.ok(a?.kind === 'invalid' && b?.kind === 'invalid');
  if (a?.kind === 'invalid' && b?.kind === 'invalid') assert.equal(a.identity, b.identity);
  const g1 = parseLine('{"v":1,"event');
  const g2 = parseLine('{"v":1,"event');
  assert.ok(g1?.kind === 'invalid' && g2?.kind === 'invalid');
  if (g1?.kind === 'invalid' && g2?.kind === 'invalid') {
    assert.equal(g1.identity, g2.identity);
    assert.ok(g1.identity.startsWith('h:'));
  }
});

test('classification order: invalid, then late, then unknown campaign, then accepted', () => {
  const known = (id: string) => id === 'k_00015';
  const base = { observedMs: 0, emittedMs: 0, campaignId: 'k_00015' };
  assert.equal(classify(base, known), 'accepted');
  assert.equal(classify({ ...base, emittedMs: LATE_MS }, known), 'accepted'); // exactly 6h is not late
  assert.equal(classify({ ...base, emittedMs: LATE_MS + 1 }, known), 'late');
  assert.equal(classify({ ...base, campaignId: 'k_99999' }, known), 'unknown_campaign');
  // late wins over unknown campaign
  assert.equal(classify({ ...base, campaignId: 'k_99999', emittedMs: LATE_MS + 1 }, known), 'late');
});

test('parseIsoMs is strict', () => {
  assert.equal(parseIsoMs('2026-01-05T00:00:00.000Z'), Date.UTC(2026, 0, 5));
  assert.equal(parseIsoMs('2026-01-05 00:00:00.000Z'), null);
  assert.equal(parseIsoMs(1767571200000), null);
});
