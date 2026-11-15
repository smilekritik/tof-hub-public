import {Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit, Optional} from '@nestjs/common';
import {Prisma, type PrismaClient} from '@prisma/client';
import Redis from 'ioredis';
import {createHash} from 'node:crypto';
import {setImmediate as yieldToRequests} from 'node:timers/promises';
import {promisify} from 'node:util';
import {gzip, gunzip} from 'node:zlib';
import {PRISMA} from '../../database/database.module';
import {loadScoringCatalog} from '../../players/scoring-catalog';
import {RaidCurrentNamesResponseSchema} from '@tof-hub/contracts';
import type {z} from 'zod';
import type {PlayerTopEntry, RankingQuery} from '../ranking.service';

export type CachedPlayerRanking = CachedRanking<PlayerTopEntry>;
export type CachedBoard = 'players' | 'gear';
export interface CachedRanking<TEntry> {
  available: boolean;
  entries: TEntry[];
  total?: number;
  overall?: number;
  databaseEmpty?: boolean;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  bypasses: number;
  errors: number;
  warmups: number;
  connected: boolean;
  revision: string;
  keysCount: number;
  gearKeysCount: number;
  pioneerKeysCount: number;
  usedMemoryHuman?: string;
}

export const REVISION_ROW_ID = 'ranking:players';
export const DEFAULT_TTL_SECONDS = 3600;
const MAX_BOARD_BYTES = 2 * 1024 * 1024;
const BOARD_COMPRESSION_THRESHOLD = 16 * 1024;
const deflateBoard = promisify(gzip);
const inflateBoard = promisify(gunzip);
type PlayerIdentities = z.infer<typeof RaidCurrentNamesResponseSchema>;

async function readBoard<TEntry>(raw: Buffer): Promise<CachedRanking<TEntry> | null> {
  const json = raw[0] === 0x1f && raw[1] === 0x8b
    ? await inflateBoard(raw, {maxOutputLength: MAX_BOARD_BYTES})
    : raw;
  const board = JSON.parse(json.toString('utf8')) as CachedRanking<TEntry>;
  return board.available === true && Array.isArray(board.entries) ? board : null;
}

@Injectable()
export class RankingCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RankingCacheService');
  private redis: Redis | null = null;
  private isConnected = false;
  private lastKnownRevision: string | null = null;
  private onRevisionChange?: (newRevision: string) => void;
  private readonly inFlight = new Map<string, Promise<CachedRanking<unknown>>>();
  private readonly snapshotFlights = new Map<string, Promise<unknown>>();
  private readonly metrics = {
    hits: 0,
    misses: 0,
    bypasses: 0,
    errors: 0,
    warmups: 0,
  };

  setOnRevisionChange(cb: (newRevision: string) => void) {
    this.onRevisionChange = cb;
  }

  isReady() { return this.redis !== null && this.isConnected && this.prisma !== null; }

  constructor(
    @Optional() @Inject(PRISMA) private readonly prisma: PrismaClient | null = null,
  ) {}

  async onModuleInit() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.log('REDIS_URL is not configured; running in direct DB fallback mode');
      return;
    }

    try {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 1500,
        commandTimeout: 500,
        enableOfflineQueue: false,
        retryStrategy: (times) => Math.min(times * 300, 3000),
      });

      this.redis.on('ready', () => {
        this.isConnected = true;
        this.logger.log('Connected to Redis');
      });

      this.redis.on('error', (err) => {
        if (this.isConnected) {
          this.logger.warn(`Redis connection error: ${err.message}`);
        }
        this.metrics.errors++;
      });

      this.redis.on('close', () => {
        this.isConnected = false;
      });

      await this.redis.connect().catch((err) => {
        this.logger.warn(`Could not connect to Redis at startup (${err.message}); will use DB fallback`);
      });
    } catch (err: any) {
      this.logger.warn(`Redis initialization failed: ${err.message}`);
      this.redis = null;
      this.isConnected = false;
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      try {
        this.redis.disconnect();
      } catch {
        // ignore shutdown error
      }
      this.redis = null;
      this.isConnected = false;
    }
  }

  /**
   * Share bounded first-page boards, including public role, verification, place and sort filters.
   * Search and deep pagination remain uncached to avoid filling Redis with one-off queries.
   */
  isWhitelisted(query: RankingQuery, board: CachedBoard = 'players'): boolean {
    if (query.offset && query.offset > 0) return false;
    if (![50, 100].includes(query.limit)) return false;
    if (query.q) return false;
    if (query.dataset) return false;
    if (!query.track) return false;
    if ((board === 'players' && query.slot) || (query.slots && query.slots.length > 0)) return false;
    if (board === 'gear' && query.slot && !Object.hasOwn(loadScoringCatalog()?.allowedStats ?? {}, query.slot)) return false;
    return true;
  }

  /**
   * Every cacheable result-shaping filter participates in the key.
   * Keep default-view keys compatible with existing warm snapshots.
   */
  canonicalQueryKey(query: RankingQuery): string {
    const role = query.role || 'dps';
    const track = query.track;
    const region = !query.region || query.region === 'all' ? 'all' : query.region;
    const limit = query.limit || 50;
    return `${role}:${track}:${region}:${limit}`
      + (query.verified ? ':verified=1' : '')
      + (query.places === 'global' ? ':places=global' : '')
      + (query.sort && query.sort !== 'grv' ? `:sort=${query.sort}` : '');
  }

  /**
   * Full cache key with version namespace: ranking:players:v{revision}:{queryKey}.
   */
  buildCacheKey(query: RankingQuery, revision: string, board: CachedBoard = 'players'): string {
    const suffix = this.canonicalQueryKey(query);
    return board === 'gear'
      ? `ranking:gear:s1:v${revision}:${suffix}:${query.slot || 'all'}`
      : `ranking:players:s2:v${revision}:${suffix}`;
  }

  /**
   * Reads the current durable data revision.
   * PostgreSQL is authoritative on every read, including reconnects and startup rescoring.
   * Redis stores results only, never a revision pointer that can outlive a missed publication.
   */
  async getRevision(id = REVISION_ROW_ID): Promise<string> {
    if (!this.prisma) throw new Error('Ranking database is not configured');
    const row = await this.prisma.scoringRevision.findUnique({where: {id}, select: {fingerprint: true}});
    const current = row?.fingerprint ?? '0';
    if (!/^\d+$/.test(current)) throw new Error('Invalid durable ranking revision');
    if (id === REVISION_ROW_ID && this.lastKnownRevision !== null && this.lastKnownRevision !== current) {
      this.logger.log(`Detected revision change in getRevision: v${this.lastKnownRevision} -> v${current}`);
      this.onRevisionChange?.(current);
    }
    if (id === REVISION_ROW_ID) this.lastKnownRevision = current;
    return current;
  }

  /**
   * Increment the durable data revision in PostgreSQL.
   * Returns the new revision number.
   */
  async bumpRevision(): Promise<string> {
    if (!this.prisma) throw new Error('Ranking database is not configured');
    const result = await this.prisma.$queryRaw<{ fingerprint: string }[]>(
      Prisma.sql`INSERT INTO scoring_revisions (id, fingerprint, updated_at)
            VALUES (${REVISION_ROW_ID}, '1', NOW())
            ON CONFLICT (id) DO UPDATE
            SET fingerprint = (scoring_revisions.fingerprint::bigint + 1)::text, updated_at = NOW()
            RETURNING fingerprint`,
    );
    if (!result?.[0]?.fingerprint) throw new Error('Ranking revision was not updated');
    const newRevision = result[0].fingerprint;

    this.logger.log(`Ranking data revision bumped to v${newRevision}`);
    const prevRev = this.lastKnownRevision;
    this.lastKnownRevision = newRevision;
    if (prevRev !== newRevision) {
      this.onRevisionChange?.(newRevision);
    }
    return newRevision;
  }

  /**
   * Retrieves cached ranking result directly by query if present.
   */
  async get<TEntry = PlayerTopEntry>(query: RankingQuery, expectedRevision?: string, board: CachedBoard = 'players'): Promise<CachedRanking<TEntry> | null> {
    if (!this.isReady() || !this.isWhitelisted(query, board)) return null;
    try {
      const revision = expectedRevision ?? await this.getRevision();
      const key = this.buildCacheKey(query, revision, board);
      const data = await this.redis!.getBuffer(key);
      if (data) return await readBoard<TEntry>(data);
    } catch {
      // Redis read failure -> fallback
    }
    return null;
  }

  /**
   * Writes ranking result to Redis with TTL.
   */
  async set<TEntry>(query: RankingQuery, data: CachedRanking<TEntry>, revision: string, board: CachedBoard = 'players'): Promise<void> {
    if (!this.isReady() || !data.available || !this.isWhitelisted(query, board)) return;
    try {
      const key = this.buildCacheKey(query, revision, board);
      const json = JSON.stringify(data);
      const bytes = Buffer.byteLength(json);
      if (bytes > MAX_BOARD_BYTES) return;
      const payload = bytes >= BOARD_COMPRESSION_THRESHOLD
        ? await deflateBoard(json, {level: 1})
        : json;
      await this.redis!.set(key, payload, 'EX', DEFAULT_TTL_SECONDS);
    } catch (err: any) {
      this.logger.warn(`Failed to cache ranking key: ${err.message}`);
    }
  }

  /**
   * Cache-aside with in-flight deduplication (stampede protection).
   */
  async getOrCompute<TEntry = PlayerTopEntry>(
    query: RankingQuery,
    compute: () => Promise<CachedRanking<TEntry>>,
    options: {refresh?: boolean; board?: CachedBoard} = {},
  ): Promise<CachedRanking<TEntry>> {
    const board = options.board ?? 'players';
    if (!this.isWhitelisted(query, board) || !this.isReady()) {
      this.metrics.bypasses++;
      return compute();
    }

    let revision: string;
    try { revision = await this.getRevision(); }
    catch {
      this.metrics.errors++;
      this.metrics.bypasses++;
      return compute();
    }
    const key = this.buildCacheKey(query, revision, board);

    // 1. Try reading from cache unless a scheduled/manual refresh was requested.
    if (this.redis && this.isConnected && !options.refresh) {
      try {
        const raw = await this.redis.getBuffer(key);
        if (raw) {
          const cached = await readBoard<TEntry>(raw);
          if (cached) {
            this.metrics.hits++;
            return cached;
          }
        }
      } catch (err: any) {
        this.logger.warn(`Redis get error: ${err.message}`);
        this.metrics.errors++;
      }
    }

    this.metrics.misses++;

    // 2. Stampede protection: join existing in-flight promise if identical query is already computing
    const existing = this.inFlight.get(key);
    if (existing) {
      // Board and every result-shaping filter are part of the key.
      return existing as Promise<CachedRanking<TEntry>>;
    }

    // 3. Compute and cache
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await compute();
        await this.set(query, result, revision, board);
        return result;
      } finally {
        this.inFlight.delete(key);
      }
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  recordWarmup() {
    this.metrics.warmups++;
  }

  /** Exact profile identities share Redis entries across batches, UID searches and nickname hovers. */
  async getPlayerIdentities(ids: string[], uids: string[], compute: (ids: string[], uids: string[]) => Promise<PlayerIdentities>): Promise<PlayerIdentities> {
    if (!this.isReady()) return compute(ids, uids);
    let revision: string;
    try { revision = await this.getRevision(); } catch { return compute(ids, uids); }
    const prefix = `ranking:identities:s1:v${revision}:`;
    const wanted = [...ids.map(value => ({kind: 'role', value})), ...uids.map(value => ({kind: 'uid', value}))];
    const keys = wanted.map(item => `${prefix}${item.kind}:${item.value}`);
    const flight = `${prefix}${createHash('sha256').update(JSON.stringify([...keys].sort())).digest('hex')}`;
    const existing = this.snapshotFlights.get(flight) as Promise<PlayerIdentities> | undefined;
    if (existing) return existing;
    const pending = Promise.resolve().then(async () => {
      let raw: (string | null)[];
      try { raw = await this.redis!.mget(...keys); } catch { this.metrics.errors++; return compute(ids, uids); }
      const entries = new Map<string, PlayerIdentities['entries'][number]>();
      const missing: typeof wanted = [];
      wanted.forEach((item, index) => {
        let parsed: ReturnType<typeof RaidCurrentNamesResponseSchema.safeParse> | undefined;
        try { if (raw[index]) parsed = RaidCurrentNamesResponseSchema.safeParse(JSON.parse(raw[index]!)); } catch { /* Treat corrupt data as a miss. */ }
        const valid = parsed?.success && parsed.data.available && parsed.data.entries.length <= 1
          && parsed.data.entries.every(entry => item.kind === 'role' ? entry.identifier === item.value : entry.uid === item.value);
        if (valid && parsed?.success) {
          this.metrics.hits++;
          for (const entry of parsed.data.entries) entries.set(entry.identifier, entry);
        } else missing.push(item);
      });
      if (!missing.length) return {available: true, entries: [...entries.values()]};
      this.metrics.misses++;
      const result = await compute(missing.filter(item => item.kind === 'role').map(item => item.value), missing.filter(item => item.kind === 'uid').map(item => item.value));
      if (!result.available) return {available: false, entries: [...entries.values()]};
      const writes = new Map<string, PlayerIdentities['entries']>();
      for (const item of missing) writes.set(`${prefix}${item.kind}:${item.value}`, []);
      for (const entry of result.entries) {
        entries.set(entry.identifier, entry);
        writes.set(`${prefix}role:${entry.identifier}`, [entry]);
        if (entry.uid) writes.set(`${prefix}uid:${entry.uid}`, [entry]);
      }
      try {
        const pipeline = this.redis!.pipeline();
        for (const [key, values] of writes) {
          const payload = JSON.stringify({available: true, entries: values});
          if (Buffer.byteLength(payload) <= 16384) pipeline.set(key, payload, 'EX', values.length ? DEFAULT_TTL_SECONDS : 30);
        }
        await pipeline.exec();
      } catch { this.metrics.errors++; }
      return {available: true, entries: [...entries.values()]};
    });
    this.snapshotFlights.set(flight, pending);
    try { return await pending; } finally { this.snapshotFlights.delete(flight); }
  }

  /** Small on-demand places, invalidated by the same durable revision as the boards. Never prewarmed. */
  async getRankMap(scope:readonly unknown[],compute:()=>Promise<Record<string,number>>):Promise<Record<string,number>> {
    let revision:string;
    try{revision=await this.getRevision();}catch{return compute();}
    const key=`ranking:ranks:v${revision}:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`;
    if(this.isReady())try{
      const raw=await this.redis!.get(key);
      if(raw){const result=JSON.parse(raw);if(result&&typeof result==='object'&&!Array.isArray(result)&&Object.keys(result).length<=100&&Object.values(result).every(value=>Number.isSafeInteger(value)&&Number(value)>0)){this.metrics.hits++;return result;}}
    }catch{this.metrics.errors++;}
    const existing=this.snapshotFlights.get(key) as Promise<Record<string,number>>|undefined;
    if(existing)return existing;
    const pending=Promise.resolve().then(async()=>{
      const result=await compute(),payload=JSON.stringify(result);
      if(this.isReady()&&Buffer.byteLength(payload)<=16*1024)await this.redis!.set(key,payload,'EX',600).catch(()=>{this.metrics.errors++;});
      return result;
    });
    this.snapshotFlights.set(key,pending);
    try{return await pending;}finally{this.snapshotFlights.delete(key);}
  }

  /** Small, expensive synthetic boards keep one bounded snapshot per role/track.
   * Live changes are coalesced for a minute; a requested refresh runs once in the
   * background while the snapshot remains within its one-day lifetime. */
  async getSnapshot<T extends {available: boolean}>(
    key: string, revision: string, compute: () => Promise<T>, options: {refresh?: boolean} = {},
  ): Promise<T> {
    const refresh = () => {
      const existing = this.snapshotFlights.get(key) as Promise<T> | undefined;
      if (existing) return existing;
      const pending = Promise.resolve().then(async () => {
        await yieldToRequests();
        const result = await compute();
        if (this.isReady() && result.available) {
          const payload = JSON.stringify({revision, at: Date.now(), result});
          if (Buffer.byteLength(payload) <= 512 * 1024) {
            await this.redis!.set(key, payload, 'EX', 86_400).catch(() => { this.metrics.errors++; });
          }
        }
        return result;
      });
      this.snapshotFlights.set(key, pending);
      void pending.finally(() => this.snapshotFlights.delete(key)).catch(() => {});
      return pending;
    };
    if (this.isReady() && !options.refresh) {
      try {
        const raw = await this.redis!.get(key);
        if (raw) {
          const snapshot = JSON.parse(raw) as {revision: string; at: number; result: T};
          const age = Date.now() - snapshot.at;
          if (snapshot.result?.available && age >= 0 && Number.isFinite(age)) {
            if (snapshot.revision === revision || age < 60_000) {
              this.metrics.hits++;
              return snapshot.result;
            }
            if (age < 86_400_000) {
              this.metrics.hits++;
              void refresh().catch((error: unknown) => this.logger.warn(`Pioneer snapshot refresh failed: ${error instanceof Error ? error.message : String(error)}`));
              return snapshot.result;
            }
          }
        }
      } catch { this.metrics.errors++; }
    }
    this.metrics.misses++;
    return refresh();
  }

  pioneerKey(query: RankingQuery) {return `ranking:pioneer:s1:${query.role}:${query.track.split('-').sort().join('-')}`;}
  async hasSnapshot(query: RankingQuery, writtenAfter = 0) {
    if (!this.isReady()) return false;
    try {
      if (!writtenAfter) return (await this.redis!.exists(this.pioneerKey(query))) === 1;
      const raw = await this.redis!.get(this.pioneerKey(query));
      if (!raw) return false;
      const snapshot = JSON.parse(raw) as {at:number; result?:{available:boolean}};
      return snapshot.at >= writtenAfter && snapshot.result?.available === true;
    } catch {return false;}
  }

  async getMetrics(): Promise<CacheMetrics> {
    const revision = await this.getRevision().catch(() => 'unavailable');
    let keysCount = 0;
    let gearKeysCount = 0;
    let pioneerKeysCount = 0;
    let usedMemoryHuman: string | undefined;

    if (this.redis && this.isConnected) {
      try {
        let cursor = '0';
        do {
          const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'ranking:*', 'COUNT', 100);
          cursor = next;
          keysCount += keys.filter(key => key.startsWith(`ranking:players:s2:v${revision}:`)).length;
          gearKeysCount += keys.filter(key => key.startsWith(`ranking:gear:s1:v${revision}:`)).length;
          pioneerKeysCount += keys.filter(key => key.startsWith('ranking:pioneer:s1:')).length;
        } while (cursor !== '0');
        const memoryInfo = await this.redis.info('memory');
        const match = /used_memory_human:([^\r\n]+)/.exec(memoryInfo);
        if (match) usedMemoryHuman = match[1].trim();
      } catch {
        // ignore
      }
    }

    return {
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      bypasses: this.metrics.bypasses,
      errors: this.metrics.errors,
      warmups: this.metrics.warmups,
      connected: this.isConnected,
      revision,
      keysCount,
      gearKeysCount,
      pioneerKeysCount,
      usedMemoryHuman,
    };
  }
}
