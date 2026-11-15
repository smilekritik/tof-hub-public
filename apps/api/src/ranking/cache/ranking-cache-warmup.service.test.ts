import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs/promises';
import {RankingCacheWarmupService,nextDailyWarmup} from './ranking-cache-warmup.service';

describe('RankingCacheWarmupService', () => {
  let warmup: RankingCacheWarmupService;
  let mockCache: any;
  let mockRanking: any;
  let cached: Set<string>;
  const key=(query:any,board='players')=>JSON.stringify({board,...query});

  beforeEach(() => {
    vi.stubEnv('RANKING_WARMUP_MODE','minimal');
    vi.spyOn(fs,'readFile').mockRejectedValue(new Error('No raid fixture'));
    cached=new Set();
    mockCache = {
      isReady:vi.fn().mockReturnValue(true),
      hasSnapshot:vi.fn(async(q:any)=>cached.has(key(q))),
      getRevision: vi.fn().mockResolvedValue('1'),
      canonicalQueryKey: vi.fn().mockImplementation((q) => `${q.role || 'dps'}:${q.track}:${q.region || 'all'}:${q.limit}${q.verified ? ':verified=1' : ''}`),
      get: vi.fn(async(q:any,_revision:string,board='players')=>cached.has(key(q,board))?{available:true,entries:[]}:null),
      recordWarmup: vi.fn(),
    };
    mockRanking = {
      players: vi.fn().mockImplementation(async(q:any)=>{
        cached.add(key(q));
        return {available:true,entries:[]};
      }),
      gear: vi.fn().mockImplementation(async(q:any)=>{
        cached.add(key(q,'gear'));
        return {available:true,entries:[]};
      }),
      currentPlayerNames: vi.fn().mockResolvedValue({available:true,entries:[]}),
    };
    warmup = new RankingCacheWarmupService(mockCache, mockRanking);
  });
  afterEach(()=>{warmup.onModuleDestroy();vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();});

  it('runs minimal warmup with prioritized queries', async () => {
    process.env.RANKING_WARMUP_MODE = 'minimal';
    const summary = await warmup.triggerWarmup('initial');

    expect(summary).not.toBeNull();
    expect(summary?.planned).toBe(14);
    expect(summary?.warmed).toBe(14);
    expect(summary?.failed).toBe(0);
    expect(mockRanking.players).toHaveBeenCalledWith(expect.objectContaining({track:'all',dataset:'pioneer'}),{refresh:false});
    expect(mockRanking.gear).toHaveBeenCalledExactlyOnceWith({track:'all',role:'dps',limit:100},{refresh:false});
    expect(mockRanking.currentPlayerNames).not.toHaveBeenCalled();
    expect(mockRanking.players.mock.calls.filter(([query]:[any])=>query.verified).map(([query]:[any])=>query)).toEqual([
      {track:'all',role:'dps',limit:50,verified:true},
      {track:'all',role:'dps',limit:100,verified:true},
    ]);
  });

  it('skips already cached queries', async () => {
    process.env.RANKING_WARMUP_MODE = 'minimal';
    cached.add(key({track:'all',role:'dps',limit:50}));
    cached.add(key({track:'all',role:'dps',limit:100}));
    cached.add(key({track:'Physical-Flame',role:'dps',region:'AP',limit:50}));
    const summary = await warmup.triggerWarmup('initial');
    expect(summary?.skipped).toBe(3);
    expect(summary?.warmed).toBe(11);
  });

  it('prevents multiple simultaneous warmups', async () => {
    process.env.RANKING_WARMUP_MODE = 'minimal';
    const promise1 = warmup.triggerWarmup('initial');
    const promise2 = warmup.triggerWarmup('revision-change');

    const [res1, res2] = await Promise.all([promise1, promise2]);
    expect(res1).not.toBeNull();
    expect(res2).toBeNull(); // second one skipped
  });

  it('runs full warmup with all tracks and regions', async () => {
    vi.useFakeTimers();
    const pending = warmup.triggerWarmup('manual', 'full');
    await vi.runAllTimersAsync();
    const summary = await pending;
    expect(summary).not.toBeNull();
    expect(summary?.planned).toBeGreaterThan(50);
    expect((summary?.warmed??0)+(summary?.skipped??0)).toBe(summary?.planned);
    expect(mockRanking.gear).toHaveBeenCalledWith({track:'Volt',role:'dps',limit:100},{refresh:false});
    expect(mockRanking.gear).toHaveBeenCalledWith({track:'all',role:'healer',limit:100},{refresh:false});
    expect(mockRanking.gear).toHaveBeenCalledWith({track:'all',role:'dps',region:'PS',limit:100},{refresh:false});
    expect(mockRanking.gear).toHaveBeenCalledWith({track:'Volt',role:'healer',region:'PS',limit:100},{refresh:false});
    expect(mockRanking.players).toHaveBeenCalledWith({track:'all',role:'tank',limit:100},{refresh:false});
    expect(mockRanking.players).toHaveBeenCalledWith({track:'Volt',role:'tank',region:'PS',limit:100},{refresh:false});
    expect(summary?.slowest).toHaveLength(5);
  });

  it('loads raid details across seasons and batches each player ID only once', async () => {
    const detailPath='runtime/details/raid-rankings/000000000000000000000001';
    const scope={kind:'region',region:'EU',serverId:null,serverName:null};
    const makeBoard=(id:string,seasonId:string,ids:number[])=>({
      id,seasonId,sourceId:'source',scope,coverage:'complete',capturedAt:null,
      entries:[{id,rank:1,duration:{raw:'1:00:00',milliseconds:60000},recordedAt:null,
        members:ids.map(identifier=>({identifier:String(identifier),nickname:'Recorded name',resonance:null}))}],
    });
    const first=makeBoard('one','S1',Array.from({length:500},(_,index)=>index+1));
    const second=makeBoard('two','S2',[500,501]);
    const index={
      schemaVersion:1,
      sources:[{id:'source',kind:'capture',title:'Capture',url:null,author:null,observedAt:'2026-10-18',sha256:'1'.repeat(64)}],
      seasons:['S1','S2'].map(id=>({id,label:id,bossLabel:null,raidId:null,raidJoin:'unresolved'})),
      boards:[{...first,entries:[],entryCount:1,_detail:detailPath},second],
    };
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(index)).mockResolvedValueOnce(JSON.stringify(first));
    vi.useFakeTimers();
    const pending=warmup.triggerWarmup('daily-03:01-utc','full',true);
    await vi.runAllTimersAsync();
    await pending;
    expect(mockRanking.currentPlayerNames).toHaveBeenCalledTimes(2);
    expect(mockRanking.currentPlayerNames).toHaveBeenNthCalledWith(1,Array.from({length:500},(_,index)=>String(index+1)));
    expect(mockRanking.currentPlayerNames).toHaveBeenNthCalledWith(2,['501']);
  });

  it('does not subscribe to imports/revisions and schedules a forced run at 03:01 UTC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T03:00:59Z'));
    mockCache.setOnRevisionChange=vi.fn();
    const triggerSpy=vi.spyOn(warmup,'triggerWarmup').mockResolvedValue(null);
    warmup.onApplicationBootstrap();
    expect(mockCache.setOnRevisionChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(triggerSpy).toHaveBeenCalledWith('daily-03:01-utc','full',true);
  });

  it('does no work when disabled or disconnected',async()=>{
    mockCache.isReady.mockReturnValue(false);
    expect(await warmup.triggerWarmup()).toBeNull();
    expect(mockRanking.players).not.toHaveBeenCalled();
    mockCache.isReady.mockReturnValue(true);
    vi.stubEnv('RANKING_WARMUP_ENABLED','false');
    expect(await warmup.triggerWarmup()).toBeNull();
  });

  it('forces recomputation even for cached targets',async()=>{
    mockCache.get.mockResolvedValue({available:true,entries:[]});
    mockCache.hasSnapshot.mockResolvedValue(true);
    const summary=await warmup.triggerWarmup('daily','minimal',true);
    expect(summary?.skipped).toBe(0);
    expect(mockRanking.players).toHaveBeenCalledTimes(13);
    expect(mockRanking.players).toHaveBeenCalledWith(expect.anything(),{refresh:true});
    expect(mockRanking.gear).toHaveBeenCalledExactlyOnceWith({track:'all',role:'dps',limit:100},{refresh:true});
  });

  it('uses UTC across day and month boundaries',()=>{
    expect(nextDailyWarmup(new Date('2026-10-31T03:01:00Z')).toISOString()).toBe('2026-11-01T03:01:00.000Z');
    expect(nextDailyWarmup(new Date('2026-10-18T03:00:00Z')).toISOString()).toBe('2026-10-18T03:01:00.000Z');
  });

  it('preserves a forced full run queued behind startup warmup',async()=>{
    vi.useFakeTimers();
    const initial=warmup.triggerWarmup('initial');
    expect(await warmup.triggerWarmup('daily-03:01-utc','full',true)).toBeNull();
    await vi.runAllTimersAsync();
    await initial;
    const forcedPlayers=mockRanking.players.mock.calls.filter(([,options]:[unknown,{refresh:boolean}])=>options.refresh);
    const forcedGear=mockRanking.gear.mock.calls.filter(([,options]:[unknown,{refresh:boolean}])=>options.refresh);
    expect(forcedGear.length).toBeGreaterThan(1);
    expect(warmup.getLastSummary()?.planned).toBe(forcedPlayers.length+forcedGear.length);
  });
});
