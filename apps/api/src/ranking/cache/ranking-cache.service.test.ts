import {describe, it, expect, vi, beforeEach} from 'vitest';
import {RankingCacheService} from './ranking-cache.service';
import type {RankingQuery} from '../ranking.service';

describe('RankingCacheService', () => {
  let cache: RankingCacheService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      scoringRevision: {
        findUnique: vi.fn().mockResolvedValue({fingerprint: '3'}),
      },
      $queryRaw: vi.fn().mockResolvedValue([{fingerprint: '4'}]),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    cache = new RankingCacheService(mockPrisma);
    const values = new Map<string,string|Buffer>();
    Object.assign(cache, {isConnected:true, redis:{
      get:vi.fn(async(key:string)=>values.get(key)??null),
      getBuffer:vi.fn(async(key:string)=>values.has(key)?Buffer.from(values.get(key)!):null),
      set:vi.fn(async(key:string,value:string|Buffer)=>{values.set(key,value);return 'OK';}),
    }});
  });

  describe('isWhitelisted', () => {
    it('allows standard default top queries', () => {
      expect(cache.isWhitelisted({track: 'all', role: 'dps', limit: 50})).toBe(true);
      expect(cache.isWhitelisted({track: 'Physical-Flame', role: 'dps', region: 'AP', limit: 100})).toBe(true);
      expect(cache.isWhitelisted({track: 'Frost-Volt', role: 'dps', region: 'EU', limit: 50})).toBe(true);
    });

    it('bypasses when query has search text', () => {
      expect(cache.isWhitelisted({track: 'all', role: 'dps', limit: 50, q: 'player1'})).toBe(false);
    });

    it('bypasses when query has non-zero offset', () => {
      expect(cache.isWhitelisted({track: 'all', role: 'dps', limit: 50, offset: 50})).toBe(false);
    });

    it('bypasses when limit exceeds 100', () => {
      expect(cache.isWhitelisted({track: 'all', role: 'dps', limit: 101})).toBe(false);
    });

    it('bypasses when dataset is pioneer', () => {
      expect(cache.isWhitelisted({track: 'all', role: 'dps', limit: 50, dataset: 'pioneer'})).toBe(false);
    });

    it('shares verified boards between visitors', () => {
      expect(cache.isWhitelisted({track: 'all', role: 'dps', limit: 50, verified: true})).toBe(true);
    });

    it('shares sorted and global-place boards', () => {
      expect(cache.isWhitelisted({track: 'all', role: 'dps', limit: 50, sort: 'cs'})).toBe(true);
      expect(cache.isWhitelisted({track: 'all', role: 'dps', limit: 50, sort: 'name-asc', places: 'global'})).toBe(true);
    });

    it('shares healer and tank boards', () => {
      expect(cache.isWhitelisted({track: 'all', role: 'healer', limit: 50})).toBe(true);
      expect(cache.isWhitelisted({track: 'all', role: 'tank', limit: 50})).toBe(true);
    });
  });

  describe('canonicalQueryKey', () => {
    it('canonicalizes missing region and region=all identically', () => {
      const q1: RankingQuery = {track: 'all', role: 'dps', limit: 50};
      const q2: RankingQuery = {track: 'all', role: 'dps', region: 'all', limit: 50};
      expect(cache.canonicalQueryKey(q1)).toBe('dps:all:all:50');
      expect(cache.canonicalQueryKey(q2)).toBe('dps:all:all:50');
    });

    it('includes specific region and limit', () => {
      const q: RankingQuery = {track: 'Physical-Flame', role: 'dps', region: 'AP', limit: 100};
      expect(cache.canonicalQueryKey(q)).toBe('dps:Physical-Flame:AP:100');
    });
  });

  describe('revisions', () => {
    it('reads durable revision from postgres', async () => {
      const rev = await cache.getRevision();
      expect(rev).toBe('3');
      expect(mockPrisma.scoringRevision.findUnique).toHaveBeenCalledWith({
        where: {id: 'ranking:players'},
        select: {fingerprint: true},
      });
    });

    it('bumps revision atomically in postgres', async () => {
      const newRev = await cache.bumpRevision();
      expect(newRev).toBe('4');
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });
  });

  describe('stampede protection (in-flight deduplication)', () => {
    it('compresses large boards and serves them through both cache read paths', async () => {
      const query: RankingQuery = {track:'all',role:'dps',limit:100};
      const result={available:true,entries:Array.from({length:100},(_,rank)=>({rank,details:'gear '.repeat(100)}))};
      const compute=vi.fn().mockResolvedValue(result);
      expect(await cache.getOrCompute(query,compute)).toEqual(result);
      const {redis}=cache as unknown as {redis:{getBuffer:(key:string)=>Promise<Buffer>}};
      const raw=await redis.getBuffer(cache.buildCacheKey(query,'3'));
      expect([...raw.subarray(0,2)]).toEqual([0x1f,0x8b]);
      expect(raw.length).toBeLessThan(JSON.stringify(result).length / 4);
      expect(await cache.get(query,'3')).toEqual(result);
      expect(await cache.getOrCompute(query,compute)).toEqual(result);
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it('shares single promise for identical concurrent queries', async () => {
      const query: RankingQuery = {track: 'all', role: 'dps', limit: 50};
      const computeFn = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {available: true, entries: [{rank: 1, score: 100}]};
      });

      // 5 concurrent calls
      const results = await Promise.all([
        cache.getOrCompute(query, computeFn),
        cache.getOrCompute(query, computeFn),
        cache.getOrCompute(query, computeFn),
        cache.getOrCompute(query, computeFn),
        cache.getOrCompute(query, computeFn),
      ]);

      expect(results).toHaveLength(5);
      expect(results[0]).toEqual({available: true, entries: [{rank: 1, score: 100}]});
      expect(computeFn).toHaveBeenCalledTimes(1);
    });

    it('gracefully falls back to compute when redis is down without throwing HTTP 500', async () => {
      Object.assign(cache,{isConnected:false});
      const query: RankingQuery = {track: 'all', role: 'dps', limit: 50};
      const computeFn = vi.fn().mockResolvedValue({available: true, entries: []});

      const result = await cache.getOrCompute(query, computeFn);
      expect(result).toEqual({available: true, entries: []});
      expect(computeFn).toHaveBeenCalledTimes(1);
    });
  });
});
