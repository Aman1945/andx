// Earnings rules (spec 4.5) and views-at-a-time (spec 4.4). Pure, unit tested.

export type CampaignTerms = { cpmCents: number; perClipCapCents: number; budgetCents: number };

export type ClipInput = { clipId: string; creatorId: string; vEnd: number };

export type ClipPaid = { clipId: string; creatorId: string; earned: number; paid: number };

export type Allocation = {
  raw: number;
  spend: number;
  exhausted: boolean;
  paidClips: number;
  clips: ClipPaid[];
};

/** earned_i = min(cap, floor(V * cpm / 1000)), in exact integer arithmetic. */
export function earnedCents(vEnd: number, t: CampaignTerms): number {
  const x = BigInt(vEnd) * BigInt(t.cpmCents);
  const e = x / 1000n; // BigInt division truncates, and x >= 0, so this is floor
  const cap = BigInt(t.perClipCapCents);
  return Number(e < cap ? e : cap);
}

/**
 * Splits the budget across a campaign's clips.
 * If raw <= budget every clip gets earned_i. Otherwise paid_i = floor(earned_i * B / raw),
 * and the `left` cents go one each to the clips with the largest remainder, ties by clip_id ascending.
 */
export function allocate(clips: ClipInput[], t: CampaignTerms): Allocation {
  const rows: ClipPaid[] = clips.map((c) => ({ clipId: c.clipId, creatorId: c.creatorId, earned: earnedCents(c.vEnd, t), paid: 0 }));
  let raw = 0;
  for (const r of rows) raw += r.earned;

  if (raw <= t.budgetCents) {
    let paidClips = 0;
    for (const r of rows) {
      r.paid = r.earned;
      if (r.paid > 0) paidClips++;
    }
    return { raw, spend: raw, exhausted: false, paidClips, clips: rows };
  }

  const B = BigInt(t.budgetCents);
  const R = BigInt(raw);
  const rem: bigint[] = new Array(rows.length);
  let sumPaid = 0n;
  for (let i = 0; i < rows.length; i++) {
    const num = BigInt(rows[i].earned) * B;
    const p = num / R;
    rem[i] = num % R;
    rows[i].paid = Number(p);
    sumPaid += p;
  }
  let left = Number(B - sumPaid);
  if (left > 0) {
    const order = rows.map((_, i) => i).filter((i) => rem[i] > 0n);
    order.sort((a, b) => {
      if (rem[a] !== rem[b]) return rem[a] > rem[b] ? -1 : 1;
      return rows[a].clipId < rows[b].clipId ? -1 : rows[a].clipId > rows[b].clipId ? 1 : 0;
    });
    for (let k = 0; k < order.length && left > 0; k++, left--) rows[order[k]].paid += 1;
  }

  let spend = 0;
  let paidClips = 0;
  for (const r of rows) {
    spend += r.paid;
    if (r.paid > 0) paidClips++;
  }
  return { raw, spend, exhausted: true, paidClips, clips: rows };
}

export type Snap = { observedMs: number; views: number };

/** V(clip, t): views of the accepted snapshot with the greatest observed_at strictly before t, else 0. */
export function viewsAt(snaps: Snap[], t: number): number {
  let best: Snap | null = null;
  for (const s of snaps) {
    if (s.observedMs < t && (best === null || s.observedMs > best.observedMs)) best = s;
  }
  return best ? best.views : 0;
}

export function viewsGained(snaps: Snap[], fromMs: number, toMs: number): number {
  return viewsAt(snaps, toMs) - viewsAt(snaps, fromMs);
}
