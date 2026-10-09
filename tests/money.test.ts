import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, earnedCents, viewsAt, viewsGained } from '../shared/src/money.ts';

const terms = { cpmCents: 100, perClipCapCents: 5000, budgetCents: 1000 };

test('earned is floor(V * cpm / 1000) capped per clip', () => {
  assert.equal(earnedCents(9_999, terms), 999);
  assert.equal(earnedCents(10_000, terms), 1000);
  assert.equal(earnedCents(10_000_000, terms), 5000);
  assert.equal(earnedCents(0, terms), 0);
});

test('under budget: every clip is paid what it earned', () => {
  const a = allocate(
    [
      { clipId: 'c_1', creatorId: 'u_1', vEnd: 3000 },
      { clipId: 'c_2', creatorId: 'u_1', vEnd: 0 },
    ],
    terms,
  );
  assert.equal(a.raw, 300);
  assert.equal(a.spend, 300);
  assert.equal(a.exhausted, false);
  assert.equal(a.paidClips, 1);
});

test('over budget: pro rata with the remainder rule, spend equals budget', () => {
  // earned: 400, 400, 400 -> raw 1200 > budget 1000
  // paid = floor(400*1000/1200) = 333 each, remainder 400 each, left = 1 -> tie broken by clip_id
  const a = allocate(
    [
      { clipId: 'c_3', creatorId: 'u_1', vEnd: 4000 },
      { clipId: 'c_1', creatorId: 'u_2', vEnd: 4000 },
      { clipId: 'c_2', creatorId: 'u_3', vEnd: 4000 },
    ],
    terms,
  );
  assert.equal(a.exhausted, true);
  assert.equal(a.raw, 1200);
  assert.equal(a.spend, 1000);
  const paid = Object.fromEntries(a.clips.map((c) => [c.clipId, c.paid]));
  assert.deepEqual(paid, { c_1: 334, c_2: 333, c_3: 333 });
});

test('remainder goes to the largest remainders first', () => {
  // earned 500, 300, 200 -> raw 1000; budget 7 -> exact: 3.5, 2.1, 1.4
  // floor: 3, 2, 1 (sum 6), remainders 500, 100, 400 (x1000), left 1 -> clip with remainder 500
  const a = allocate(
    [
      { clipId: 'c_a', creatorId: 'u', vEnd: 5000 },
      { clipId: 'c_b', creatorId: 'u', vEnd: 3000 },
      { clipId: 'c_c', creatorId: 'u', vEnd: 2000 },
    ],
    { cpmCents: 100, perClipCapCents: 5000, budgetCents: 7 },
  );
  assert.deepEqual(
    a.clips.map((c) => c.paid),
    [4, 2, 1],
  );
  assert.equal(a.spend, 7);
});

test('spend never exceeds budget on randomized inputs', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let round = 0; round < 200; round++) {
    const n = 1 + Math.floor(rnd() * 60);
    const t = { cpmCents: 1 + Math.floor(rnd() * 500), perClipCapCents: 1 + Math.floor(rnd() * 10000), budgetCents: Math.floor(rnd() * 50000) };
    const clips = Array.from({ length: n }, (_, i) => ({ clipId: 'c_' + String(i).padStart(7, '0'), creatorId: 'u', vEnd: Math.floor(rnd() * 5_000_000) }));
    const a = allocate(clips, t);
    assert.ok(a.spend <= t.budgetCents);
    if (a.exhausted) assert.equal(a.spend, t.budgetCents);
    else assert.equal(a.spend, a.raw);
  }
});

test('V(clip, t) takes the latest observation strictly before t, even if lower', () => {
  const snaps = [
    { observedMs: 10, views: 100 },
    { observedMs: 30, views: 50 }, // downward revision
    { observedMs: 20, views: 200 },
  ];
  assert.equal(viewsAt(snaps, 10), 0); // strictly before
  assert.equal(viewsAt(snaps, 11), 100);
  assert.equal(viewsAt(snaps, 25), 200);
  assert.equal(viewsAt(snaps, 31), 50);
});

test('views_gained with a downward revision that arrives out of order', () => {
  // arrival order differs from observed order; the revision (obs 40) arrives first
  const arrived = [
    { observedMs: 40, views: 300 },
    { observedMs: 10, views: 100 },
    { observedMs: 30, views: 900 },
  ];
  assert.equal(viewsGained(arrived, 20, 35), 800); // 900 - 100
  assert.equal(viewsGained(arrived, 35, 50), -600); // 300 - 900, would not be listed
  assert.equal(viewsGained(arrived, 0, 50), 300);
});
