// Line validation (spec 4.1) and malformed-line identity (spec 4.3).
// Pure functions with no I/O, so they are unit tested directly.
import { createHash } from 'node:crypto';

export const LATE_MS = 21_600_000; // 6 hours; late means strictly greater
const MIN_TS = Date.UTC(2020, 0, 1);
const MAX_TS = Date.UTC(2100, 0, 1); // exclusive
const MAX_VIEWS = 2_000_000_000;

const EVENT_ID = /^[0-9a-f]{16}$/;
const CLIP_ID = /^c_\d{7}$/;
const CAMPAIGN_ID = /^k_\d{5}$/;
const CREATOR_ID = /^u_\d{6}$/;
const ISO_MS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

export type Snapshot = {
  kind: 'view';
  eventId: string;
  clipId: string;
  campaignId: string;
  creatorId: string;
  observedMs: number;
  emittedMs: number;
  views: number;
};

export type ClipText = {
  kind: 'text';
  eventId: string;
  clipId: string;
  campaignId: string;
  caption: string;
  transcript: string;
};

export type Invalid = { kind: 'invalid'; identity: string; raw: string };

export type Parsed = Snapshot | ClipText | Invalid;

/** Parses `YYYY-MM-DDTHH:MM:SS.sssZ` into epoch ms, or null if the shape or the calendar date is wrong. */
export function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = ISO_MS.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(t);
  // Rejects day overflow such as Feb 30, and two-digit years that Date.UTC maps to 19xx.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const inTsRange = (t: number) => t >= MIN_TS && t < MAX_TS;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Identity of a malformed line: its string event_id if it is a JSON object that has one, else SHA-256 of the line. */
export function invalidIdentity(line: string, parsed: unknown): string {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const id = (parsed as Record<string, unknown>).event_id;
    if (typeof id === 'string') return 'e:' + id;
  }
  return 'h:' + createHash('sha256').update(line).digest('hex');
}

/**
 * Validates one NDJSON line. Returns null for lines that must be ignored (empty),
 * otherwise a normalized snapshot, clip text, or an invalid marker with its identity.
 */
export function parseLine(input: string): Parsed | null {
  const line = input.endsWith('\r') ? input.slice(0, -1) : input;
  if (line.length === 0) return null;

  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return { kind: 'invalid', identity: invalidIdentity(line, undefined), raw: line };
  }
  const bad = (): Invalid => ({ kind: 'invalid', identity: invalidIdentity(line, o), raw: line });

  if (o === null || typeof o !== 'object' || Array.isArray(o)) return bad();
  const r = o as Record<string, unknown>;

  if (r.v !== 1 && r.v !== 2) return bad();
  if (typeof r.event_id !== 'string' || !EVENT_ID.test(r.event_id)) return bad();

  let type: 'view_snapshot' | 'clip_text';
  if (r.v === 1) {
    if (has(r, 'type') && r.type !== 'view_snapshot') return bad();
    type = 'view_snapshot';
  } else {
    if (r.type !== 'view_snapshot' && r.type !== 'clip_text') return bad();
    type = r.type;
  }

  if (typeof r.clip_id !== 'string' || !CLIP_ID.test(r.clip_id)) return bad();
  if (typeof r.campaign_id !== 'string' || !CAMPAIGN_ID.test(r.campaign_id)) return bad();

  if (type === 'clip_text') {
    if (typeof r.caption !== 'string' || codePointLength(r.caption) > 5000) return bad();
    if (typeof r.transcript !== 'string' || codePointLength(r.transcript) > 20000) return bad();
    return {
      kind: 'text',
      eventId: r.event_id,
      clipId: r.clip_id,
      campaignId: r.campaign_id,
      caption: r.caption,
      transcript: r.transcript,
    };
  }

  if (typeof r.creator_id !== 'string' || !CREATOR_ID.test(r.creator_id)) return bad();

  let observedMs: number | null;
  let emittedMs: number | null;
  let views: unknown;
  if (r.v === 1) {
    observedMs = parseIsoMs(r.observed_at);
    emittedMs = parseIsoMs(r.emitted_at);
    views = r.views;
  } else {
    observedMs = isInt(r.observed_at_ms) ? r.observed_at_ms : null;
    emittedMs = isInt(r.emitted_at_ms) ? r.emitted_at_ms : null;
    views = r.view_count;
  }
  if (observedMs === null || emittedMs === null) return bad();
  if (!inTsRange(observedMs) || !inTsRange(emittedMs)) return bad();
  if (!isInt(views) || views < 0 || views > MAX_VIEWS) return bad();
  if (emittedMs < observedMs) return bad();

  return {
    kind: 'view',
    eventId: r.event_id,
    clipId: r.clip_id,
    campaignId: r.campaign_id,
    creatorId: r.creator_id,
    observedMs,
    emittedMs,
    views,
  };
}

export type Outcome = 'late' | 'unknown_campaign' | 'accepted';

/** Classification rules 2 to 4 for a valid snapshot (rule 1 is parseLine). */
export function classify(s: Pick<Snapshot, 'observedMs' | 'emittedMs' | 'campaignId'>, isRegistered: (campaignId: string) => boolean): Outcome {
  if (s.emittedMs - s.observedMs > LATE_MS) return 'late';
  if (!isRegistered(s.campaignId)) return 'unknown_campaign';
  return 'accepted';
}

/** 16 hex chars -> signed 64-bit decimal string, so event ids are stored as Postgres bigint. */
export function eventIdToBigint(hex: string): string {
  return BigInt.asIntN(64, BigInt('0x' + hex)).toString();
}
