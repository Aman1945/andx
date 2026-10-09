// Shared plumbing: config, Postgres pool, Redis Streams consumer loop, logging.
import pg from 'pg';
import { Redis } from 'ioredis';

export const env = {
  pgUrl: process.env.DATABASE_URL ?? 'postgres://andx:andx@localhost:5432/andx',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
};

// Stream names. Every message body is JSON in field "m" and carries a version "v".
export const STREAMS = {
  views: 'ingest.views', // gateway -> aggregator: view snapshots + invalid lines
  text: 'ingest.text', // gateway -> classifier: clip_text events
  clipChanges: 'clip.changes', // aggregator (outbox) -> earnings
  commands: 'commands', // api -> aggregator: DLQ replay requests
} as const;

export function log(service: string, msg: string, extra?: Record<string, unknown>) {
  const line = { t: new Date().toISOString(), service, msg, ...extra };
  console.log(JSON.stringify(line));
}

export function makePool(max = 10): pg.Pool {
  // bigint (int8) comes back as string by default; our counters and ids fit in a JS number.
  pg.types.setTypeParser(20, (v: string) => Number(v));
  return new pg.Pool({ connectionString: env.pgUrl, max });
}

export function makeRedis(name: string): Redis {
  return new Redis(env.redisUrl, {
    connectionName: name,
    maxRetriesPerRequest: null, // keep retrying through a broker restart instead of failing commands
    retryStrategy: (n) => Math.min(200 + n * 200, 2000),
    enableOfflineQueue: true,
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries fn until it succeeds, for startup ordering (DB, schemas created by other services). */
export async function retryUntil<T>(what: string, service: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i % 10 === 0) log(service, `waiting for ${what}`, { error: String(e) });
      await sleep(1000);
    }
  }
}

export async function ensureGroup(redis: Redis, stream: string, group: string) {
  try {
    await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
  } catch (e) {
    if (!String(e).includes('BUSYGROUP')) throw e;
  }
}

export type StreamMsg = { id: string; body: any };

/**
 * Reads a batch for a consumer group. After a restart it first re-reads this consumer's
 * own pending (delivered, unacked) entries, then switches to new entries.
 */
export class GroupReader {
  private pendingDone = false;
  private redis: Redis;
  private stream: string;
  private group: string;
  private consumer: string;
  constructor(redis: Redis, stream: string, group: string, consumer: string) {
    this.redis = redis;
    this.stream = stream;
    this.group = group;
    this.consumer = consumer;
  }

  async read(count: number, blockMs: number): Promise<StreamMsg[]> {
    const id = this.pendingDone ? '>' : '0';
    const args: (string | number)[] = ['GROUP', this.group, this.consumer, 'COUNT', count];
    if (this.pendingDone && blockMs > 0) args.push('BLOCK', blockMs);
    args.push('STREAMS', this.stream, id);
    const res = (await (this.redis as any).xreadgroup(...args)) as [string, [string, string[]][]][] | null;
    const entries = res?.[0]?.[1] ?? [];
    if (!this.pendingDone && entries.length === 0) {
      this.pendingDone = true;
      return this.read(count, blockMs);
    }
    const out: StreamMsg[] = [];
    for (const [entryId, fields] of entries) {
      if (!fields) continue; // entry deleted while pending
      const i = fields.indexOf('m');
      out.push({ id: entryId, body: i >= 0 ? JSON.parse(fields[i + 1]) : null });
    }
    return out;
  }

  /** After a failed batch, go back to re-reading our own pending entries before new ones. */
  rewind() {
    this.pendingDone = false;
  }

  /** Ack and delete: each stream has exactly one consumer group, so acked entries can go. */
  async ackAndDelete(ids: string[]) {
    if (ids.length === 0) return;
    await this.redis.multi().xack(this.stream, this.group, ...ids).xdel(this.stream, ...ids).exec();
  }

  /** After a broker restart the group can vanish only if data was lost; recreate so we keep running. */
  async ensure() {
    await ensureGroup(this.redis, this.stream, this.group);
  }
}

export function onShutdown(fn: () => Promise<void> | void) {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      try {
        await fn();
      } finally {
        process.exit(0);
      }
    });
  }
}
