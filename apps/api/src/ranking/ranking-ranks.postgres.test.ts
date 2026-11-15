import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PrismaPg} from '@prisma/adapter-pg';
import {PrismaClient} from '@prisma/client';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {RankingService,parseRankingQuery} from './ranking.service';
const url=process.env.TOF_HUB_TEST_DATABASE_URL;
describe.skipIf(!url)('batched piece places on isolated PostgreSQL',()=>{
  const schema='rank_test_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url});
  const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`}),prisma=new PrismaClient({adapter:new PrismaPg(pool,{schema})});
  const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE players(id text PRIMARY KEY,hidden boolean NOT NULL);
      CREATE TABLE gear_items(id text PRIMARY KEY,player_id text NOT NULL);
      CREATE TABLE gear_scores(gear_item_id text,track text,slot text,region text,score double precision,max_score double precision);`);
    await pool.query(`INSERT INTO players VALUES ('visible',false),('hidden',true)`);
    for(const [n,slot,region,score,max,owner] of [[1,'helmet','EU',90,100,'visible'],[2,'helmet','EU',90,101,'visible'],[3,'helmet','NA',91,100,'visible'],[4,'boots','EU',1,100,'visible'],[5,'helmet','EU',99,100,'hidden'],[6,'helmet','EU',90,100,'visible']] as const){
      await pool.query('INSERT INTO gear_items VALUES ($1,$2)',[id(n),owner]);
      await pool.query('INSERT INTO gear_scores VALUES ($1,$2,$3,$4,$5,$6)',[id(n),'best:Flame-Physical',slot,region,score,max]);
    }
  });
  afterAll(async()=>{await prisma.$disconnect();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});
  it('partitions by own slot before filtering ids, excludes hidden owners and preserves all tie breakers',async()=>{
    const service=new RankingService(prisma);
    const query=parseRankingQuery({track:'Flame-Physical',verified:'1',region:'EU'});
    expect((await service.gearRanks(query,[id(1),id(4),id(6)])).ranks).toEqual({[id(1)]:2,[id(4)]:1,[id(6)]:3});
    expect((await service.gearRanks({...query,places:'global'},[id(1),id(6)])).ranks).toEqual({[id(1)]:3,[id(6)]:4});
    expect((await service.gearRanks({...query,slot:'helmet'},[id(4),id(4),id(3),id(5),id(7)])).ranks).toEqual({[id(4)]:1});
    expect((await service.gearRanks(query,[])).ranks).toEqual({});
  });
});
