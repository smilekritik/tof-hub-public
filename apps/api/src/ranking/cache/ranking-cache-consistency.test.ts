import {beforeEach,describe,expect,it,vi} from 'vitest';
import {RankingCacheService} from './ranking-cache.service';
import type {RankingQuery} from '../ranking.service';

vi.mock('../../players/scoring-catalog',()=>({loadScoringCatalog:()=>({allowedStats:{helmet:[]}})}));

const query:RankingQuery={track:'all',role:'dps',limit:100};
describe('Ranking cache consistency and bounded snapshots',()=>{
  let revision:string, cache:RankingCacheService;
  let values:Map<string,string>;
  let redis:ReturnType<typeof makeRedis>;
  function makeRedis(){return {
    get:vi.fn(async(key:string)=>values.get(key)??null),
    getBuffer:vi.fn(async(key:string)=>values.has(key)?Buffer.from(values.get(key)!):null),
    set:vi.fn(async(key:string,value:string)=>{values.set(key,value);return 'OK';}),
    exists:vi.fn(async(key:string)=>values.has(key)?1:0),
  };}
  beforeEach(()=>{
    revision='2';values=new Map();redis=makeRedis();
    cache=new RankingCacheService({scoringRevision:{findUnique:vi.fn(async()=>({fingerprint:revision}))},
      $queryRaw:vi.fn(async()=>[{fingerprint:String(Number(revision)+1)}])} as never);
    Object.assign(cache,{redis,isConnected:true});
  });
  it('never trusts a stale Redis revision after a repository/startup update',async()=>{
    values.set('ranking:players:revision','1');
    values.set(cache.buildCacheKey(query,'1'),JSON.stringify({available:true,entries:[],total:1}));
    const compute=vi.fn(async()=>({available:true,entries:[],total:2}));
    expect(await cache.getOrCompute(query,compute)).toMatchObject({total:2});
    expect(await cache.getOrCompute(query,compute)).toMatchObject({total:2});
    expect(compute).toHaveBeenCalledOnce();
    revision='3';
    await cache.getOrCompute(query,compute);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(redis.set).not.toHaveBeenCalledWith('ranking:players:revision',expect.anything());
  });
  it('coalesces piece-place requests, invalidates them after import, and retries failed computations',async()=>{
    const scope=['gear','best:Flame-Physical','EU',true,['piece']],compute=vi.fn(async()=>({piece:2}));
    expect(await Promise.all([cache.getRankMap(scope,compute),cache.getRankMap(scope,compute)])).toEqual([{piece:2},{piece:2}]);
    await cache.getRankMap(scope,compute);expect(compute).toHaveBeenCalledOnce();
    revision='3';await cache.getRankMap(scope,compute);expect(compute).toHaveBeenCalledTimes(2);
    const failed=vi.fn().mockRejectedValueOnce(Error('database timeout')).mockResolvedValue({piece:3});
    await expect(cache.getRankMap(['retry'],failed)).rejects.toThrow('database timeout');
    expect(await cache.getRankMap(['retry'],failed)).toEqual({piece:3});
    expect(failed).toHaveBeenCalledTimes(2);
  });
  it('bypasses caching if the durable revision cannot be verified',async()=>{
    revision='invalid';
    const compute=vi.fn(async()=>({available:true,entries:[]}));
    await cache.getOrCompute(query,compute);
    expect(compute).toHaveBeenCalledOnce();expect(redis.get).not.toHaveBeenCalled();
  });
  it('does not cache unavailable responses or failures',async()=>{
    await cache.getOrCompute(query,async()=>({available:false,entries:[]}));
    expect(redis.set).not.toHaveBeenCalled();
    await expect(cache.getOrCompute(query,async()=>{throw new Error('database failed');})).rejects.toThrow('database failed');
    expect(redis.set).not.toHaveBeenCalled();
  });
  it('can force refresh a cached board without changing the durable revision',async()=>{
    values.set(cache.buildCacheKey(query,'2'),JSON.stringify({available:true,entries:[],total:1}));
    const result=await cache.getOrCompute(query,async()=>({available:true,entries:[],total:2}),{refresh:true});
    expect(result.total).toBe(2);expect(await cache.get(query)).toMatchObject({total:2});
  });
  it('separates gear, player and slot results and invalidates gear with the durable revision',async()=>{
    const players=vi.fn(async()=>({available:true,entries:[{kind:'player'}]}));
    const gear=vi.fn(async()=>({available:true,entries:[{kind:'gear'}]}));
    const helmet=vi.fn(async()=>({available:true,entries:[{kind:'helmet'}]}));
    await cache.getOrCompute(query,players);
    expect(await cache.getOrCompute(query,gear,{board:'gear'})).toMatchObject({entries:[{kind:'gear'}]});
    expect(await cache.getOrCompute(query,gear,{board:'gear'})).toMatchObject({entries:[{kind:'gear'}]});
    const slotQuery={...query,slot:'helmet'};
    await cache.getOrCompute(slotQuery,helmet,{board:'gear'});
    await cache.getOrCompute(slotQuery,helmet,{board:'gear'});
    expect(players).toHaveBeenCalledOnce();expect(gear).toHaveBeenCalledOnce();expect(helmet).toHaveBeenCalledOnce();
    expect(await cache.get(query,undefined,'gear')).toMatchObject({entries:[{kind:'gear'}]});
    revision='3';
    await cache.getOrCompute(query,gear,{board:'gear'});
    expect(gear).toHaveBeenCalledTimes(2);
  });
  it('does not let searched, paginated or oversized gear queries fill Redis',async()=>{
    const compute=vi.fn(async()=>({available:true,entries:[]}));
    for(const extra of [{q:'someone'},{offset:100},{slots:['helmet']},{slot:'inventedslot'}]) {
      await cache.getOrCompute({...query,...extra},compute,{board:'gear'});
    }
    await cache.getOrCompute(query,async()=>({available:true,entries:['a'.repeat(2*1024*1024)]}),{board:'gear'});
    expect(redis.set).not.toHaveBeenCalled();
  });
  it('shares the same filtered board across clients without mixing verification, roles, sorting or places',async()=>{
    const queries=[
      query,
      {...query,verified:true},
      {...query,verified:true,role:'healer' as const},
      {...query,verified:true,sort:'cs' as const},
      {...query,verified:true,places:'global' as const},
      {...query,verified:true,sort:'cs' as const,places:'global' as const},
    ];
    const computes=queries.map((_,index)=>vi.fn(async()=>({available:true,entries:[{kind:index}]})));
    for(const [index,filtered] of queries.entries()) {
      await cache.getOrCompute(filtered,computes[index]);
      const anotherClient=new RankingCacheService({scoringRevision:{findUnique:vi.fn(async()=>({fingerprint:revision}))}} as never);
      Object.assign(anotherClient,{redis,isConnected:true});
      expect(await anotherClient.getOrCompute(filtered,computes[index])).toMatchObject({entries:[{kind:index}]});
      expect(computes[index]).toHaveBeenCalledOnce();
    }
    expect(new Set(queries.map(filtered=>cache.buildCacheKey(filtered,revision))).size).toBe(queries.length);
    expect(cache.buildCacheKey({...query,verified:false,sort:'grv',places:'region'},revision)).toBe(cache.buildCacheKey(query,revision));
    const filtered={...query,verified:true};
    await cache.getOrCompute(filtered,computes[1],{board:'gear'});
    expect(computes[1]).toHaveBeenCalledTimes(2);
    revision='3';
    await cache.getOrCompute(filtered,computes[1]);
    expect(computes[1]).toHaveBeenCalledTimes(3);
  });
  it('keeps a small Pioneer snapshot responsive while one refresh runs',async()=>{
    const key=cache.pioneerKey({...query,dataset:'pioneer'});
    values.set(key,JSON.stringify({revision:'old',at:Date.now()-4*60*60_000,result:{available:true,total:1}}));
    let finish!:(value:{available:boolean;total:number})=>void;
    const compute=vi.fn(()=>new Promise<{available:boolean;total:number}>(resolve=>{finish=resolve;}));
    expect(await cache.getSnapshot(key,'new',compute)).toMatchObject({total:1});
    expect(await cache.getSnapshot(key,'new',compute)).toMatchObject({total:1});
    await vi.waitFor(()=>expect(compute).toHaveBeenCalledOnce());
    finish({available:true,total:2});
    await vi.waitFor(()=>expect(JSON.parse(values.get(key)!).result.total).toBe(2));
  });
  it('coalesces cold Pioneer requests and bounds their stored payload',async()=>{
    const key=cache.pioneerKey(query);
    const compute=vi.fn(async()=>({available:true,total:2}));
    await Promise.all([cache.getSnapshot(key,'2',compute),cache.getSnapshot(key,'2',compute)]);
    expect(compute).toHaveBeenCalledOnce();
    await cache.getSnapshot(key,'2',compute,{refresh:true});
    expect(compute).toHaveBeenCalledTimes(2);
    redis.set.mockClear();
    await cache.getSnapshot('ranking:pioneer:oversize','2',async()=>({available:true,padding:'a'.repeat(600*1024)}));
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('does not serve a changed Pioneer snapshot beyond its one-day lifetime',async()=>{
    const key=cache.pioneerKey(query);
    values.set(key,JSON.stringify({revision:'old',at:Date.now()-25*60*60_000,result:{available:true,total:1}}));
    const compute=vi.fn(async()=>({available:true,total:2}));
    expect(await cache.getSnapshot(key,'new',compute)).toMatchObject({total:2});
    expect(compute).toHaveBeenCalledOnce();
  });
});
