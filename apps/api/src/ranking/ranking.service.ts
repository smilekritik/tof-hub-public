import {BadRequestException,Inject,Injectable,Optional} from '@nestjs/common';
import {Prisma,type PrismaClient} from '@prisma/client';
import {PRISMA} from '../database/database.module';
import {ServerRegionCodeSchema,type TestServerParticipation} from '@tof-hub/contracts';
import {TestAccountsService} from '../players/test-accounts.service';
import {playerSearch} from '../players/player-search';
import {bestTrackId} from './best-tracks';
import {PioneerService} from './pioneer/pioneer.service';
import {gearTopView as gearView} from './gear-view';

/** Element tracks: mono or duo; each duo stat kind inherits its highest complete-set native total. */
const TRACK=/^(all|(Frost|Volt|Flame|Physical|Altered)(-(Frost|Volt|Flame|Physical|Altered))?)$/;
/** `all`: every item / player at its best track; Altered tracks are not ranked there. */
/** What the scores rate: DPS damage, healer ATK, tank resistance. */
const ROLE=/^(dps|healer|tank)$/;
export type RankingRole='dps'|'healer'|'tank';
/** Stored track of a role (game-domain roleTrackId): DPS plain, healer / tank prefixed. */
const stored=(role:RankingRole,track:string)=>role==='dps'?track:`${role}:${track}`;
/** The page's track of a stored row, without the role prefix. */
export const pageTrack=(track:string)=>track.replace(/^(healer|tank):/,'');
/**
 * The one stored track a query reads, so every board is a single indexed range with LIMIT. `all` and an unordered pair
 * (Frost / Volt, Physical / Flame) read the best rows written with the scores (best-tracks.ts): each item / player
 * once, at its best track of the role (Altered included) or at the better orientation of the pair.
 */
export function trackFilter(track:string,role:RankingRole='dps') {
  return {track:track==='all'||track.includes('-')?bestTrackId(role,track):stored(role,track)};
}
const SLOT=/^[a-z]{3,16}$/;
export const MAX_TOP_LIMIT=100;
/** Deepest page a board serves (100 000 rows). */
export const MAX_TOP_OFFSET=100_000;
/** Search text: nickname (current or former), UID prefix, server name / id, region code. */
const SEARCH_MAX=40;

export interface RankingQuery {track:string;role:RankingRole;slot?:string;region?:string;limit:number;q?:string;
  dataset?:'pioneer';
  verified?:boolean;places?:'region'|'global';sort?:'grv'|'grv-asc'|'cs'|'cs-asc'|'aug'|'aug-asc'|'name-asc'|'name-desc';
  /** Rows skipped (the page keeps loading while it is scrolled: 0, 100, 200 …). */
  offset?:number;
  /** Gear board: slots whose localized item name matched the search on the page. */
  slots?:string[]}
export interface GearTopEntry {
  rank:number;score:number;maxScore:number;
  /** Track of this score (the best one when the query asked for `all`). */
  track:string;
  player:{nickname:string|null;uid:string|null;region:string|null;serverId:string|null};
  gear:{id:string;slot:string;itemId:string;stars:number;enhancement:number;titan:boolean;augmented:boolean;rareId:string|null;rareLevel:number|null;
    stats:unknown;statsBeforeTitan:unknown;augments:unknown;lastSeenAt:string;source:string;
    /** Titan clicks (Augmentation Count) when an own capture brought it. */
    augmentCount:number|null;ownerNickname?:string|null;ownerRegion?:string|null;ownerServerId?:string|null};
}
export interface PlayerTopEntry {
  /** The owner submitted a sealed own profile; independent of the best gear set and card verification. */
  verified?:boolean;
  synthetic?:'pioneer'|'global'|'regional';comparisonDelta?:number;
  rank:number;score:number;maxScore:number;
  /** Track of this score (the best one when the query asked for `all`). */
  track:string;
  player:{nickname:string|null;uid:string|null;region:string|null;serverId:string|null;combatScore:number|null;maxCombatScore:number|null;maxCombatScoreAt?:string|null;testServers?:TestServerParticipation[]};
  /** Null when the player is known only from gear updates (inspects), without a build card. */
  buildId:string|null;updatedAt:string;
  /** The pieces behind the score: per slot the best known piece for the track (equipped or not). */
  gear:GearTopEntry['gear'][];
}

export function parseRankingQuery(raw:Record<string,unknown>):RankingQuery {
  const text=(value:unknown)=>typeof value==='string'&&value?value:undefined;
  const track=text(raw.track),slot=text(raw.slot),region=text(raw.region),role=text(raw.role)??'dps';
  const dataset=text(raw.dataset);
  if(dataset&&dataset!=='pioneer')throw new BadRequestException('Invalid dataset');
  if(dataset&&region)throw new BadRequestException('Pioneer cannot be combined with live regions');
  if(!track||!TRACK.test(track))throw new BadRequestException('Invalid track');
  if(!ROLE.test(role))throw new BadRequestException('Invalid role');
  // A tank has no pair tracks: resistance is not inherited.
  if(role==='tank'&&track.includes('-'))throw new BadRequestException('Invalid track');
  if(slot&&!SLOT.test(slot))throw new BadRequestException('Invalid slot');
  if(region&&!ServerRegionCodeSchema.safeParse(region).success)throw new BadRequestException('Invalid region');
  const limit=Number(text(raw.limit)??50);
  if(!Number.isInteger(limit)||limit<1||limit>MAX_TOP_LIMIT)throw new BadRequestException('Invalid limit');
  const q=text(raw.q)?.trim();
  if(q&&q.length>SEARCH_MAX)throw new BadRequestException('Invalid search');
  const offset=Number(text(raw.offset)??0);
  if(!Number.isInteger(offset)||offset<0||offset>MAX_TOP_OFFSET)throw new BadRequestException('Invalid offset');
  const slots=text(raw.slots)?.split(',').filter(Boolean);
  if(slots&&(slots.length>16||!slots.every(item=>SLOT.test(item))))throw new BadRequestException('Invalid slots');
  const verified=text(raw.verified),places=text(raw.places),sort=text(raw.sort);
  if(verified&&!['0','1'].includes(verified))throw new BadRequestException('Invalid verified filter');
  if(places&&!['region','global'].includes(places))throw new BadRequestException('Invalid places');
  if(sort&&!['grv','grv-asc','cs','cs-asc','aug','aug-asc','name-asc','name-desc'].includes(sort))throw new BadRequestException('Invalid sort');
  return {track,role:role as RankingRole,slot,region,limit,...(dataset?{dataset:'pioneer' as const}:{}),...(offset?{offset}:{}),...(q?{q}:{}),...(slots?.length?{slots}:{}),
    ...(verified==='1'?{verified:true}:{}),...(places?{places:places as 'region'|'global'}:{}),...(sort?{sort:sort as RankingQuery['sort']}:{})};
}

/**
 * Player condition of a search: nickname or a former nickname (case-insensitive substring), UID prefix, a server whose
 * name or id matches (contracts server catalog), or the region code.
 */
export {playerSearch} from '../players/player-search';

import {RankingCacheService} from './cache/ranking-cache.service';

/**
 * Read side of gear and player ranking. Rows are written when builds are stored;
 * without Postgres the endpoints report `available: false` and the page shows its empty state.
 */
@Injectable()
export class RankingService {
  /** Indexed role_id/UID lookup; hidden profiles and unrelated names never leave the store. */
  async currentPlayerNames(identifiers: string[], uids: string[] = []) {
    if (!this.prisma) return {available: false, entries: []};
    const ids = [...new Set(identifiers)];
    const publicIds = [...new Set(uids)];
    if (!ids.length && !publicIds.length) return {available: true, entries: []};
    const compute = async (roleIds: string[], playerUids: string[]) => {
      const identity: Prisma.PlayerWhereInput = playerUids.length
        ? {roleId: {not: null}, OR: [...(roleIds.length ? [{roleId: {in: roleIds}}] : []), {uid: {in: playerUids}}]}
        : {roleId: {in: roleIds}};
      const players = await this.prisma!.player.findMany({
        where: {...identity, hidden: false},
        select: {roleId: true, uid: true, nickname: true, lastSeenAt: true},
      });
      return {available: true, entries: players.map(player => ({identifier: player.roleId!, uid: player.uid, nickname: player.nickname ?? '', observedAt: player.lastSeenAt.toISOString()}))};
    };
    return this.cache ? this.cache.getPlayerIdentities(ids, publicIds, compute) : compute(ids, publicIds);
  }
  constructor(@Optional() @Inject(PRISMA) private readonly prisma:PrismaClient|null=null,@Optional() @Inject(PioneerService) private readonly pioneer:PioneerService|null=null,
    @Optional() @Inject(TestAccountsService) private readonly testAccounts:TestAccountsService|null=null,
    @Optional() @Inject(RankingCacheService) private readonly cache:RankingCacheService|null=null) {}

  /** Player verification records an own profile import; individual gear still requires its own known originals. */
  private async verifiedIds(board:'gear'|'players',query:RankingQuery):Promise<string[]> {
    const track=trackFilter(query.track,query.role).track;
    const known=Prisma.sql`(g.source='self' AND jsonb_path_exists(g.stats_before_titan, '$[*] ? (@ != null)'))`;
    const rows=board==='gear'
      ?await this.prisma!.$queryRaw<{id:string}[]>(Prisma.sql`SELECT s.gear_item_id AS id FROM gear_scores s
        JOIN gear_items g ON g.id=s.gear_item_id WHERE s.track=${track} AND ${known}`)
      :await this.prisma!.$queryRaw<{id:string}[]>(Prisma.sql`SELECT s.player_id AS id FROM player_scores s
        JOIN players p ON p.id=s.player_id
        WHERE s.track=${track} AND cardinality(s.gear_ids)>0 AND p.self_capture_at IS NOT NULL`);
    return rows.map(row=>row.id);
  }

  /**
   * Rank of a search hit on the whole board: rows of the same board placed above it, plus one. Each count is an
   * index range on (track, [slot,] region, score); only the matched rows (at most `limit`) are counted.
   */
  private rank<W extends object>(count:(where:W)=>Promise<number>,base:W,row:{score:number;maxScore:number},tie?:object) {
    return count({...base,OR:[{score:{gt:row.score}},{score:row.score,maxScore:{gt:row.maxScore}},
      ...(tie?[{score:row.score,maxScore:row.maxScore,...tie}]:[])]}).then(above=>above+1);
  }

  /** Rank a page/drawer in one SQL statement and one connection. Search/verified affect membership, never places. */
  private async storedRanks(board:'gear'|'players',query:RankingQuery,ids:string[],perSlot=false):Promise<Record<string,number>> {
    if(!ids.length)return {};
    const gear=board==='gear',table=gear?Prisma.sql`gear_scores`:Prisma.sql`player_scores`,id=gear?Prisma.sql`s.gear_item_id`:Prisma.sql`s.player_id`;
    const {track}=trackFilter(query.track,query.role);
    const region=query.region&&query.places!=='global'?query.region:null;
    const regionFilter=region?Prisma.sql`AND s.region=${region}`:Prisma.empty;
    const uniqueIds=[...new Set(ids)].sort();
    const gearVisibility=Prisma.sql`JOIN gear_items g ON g.id=s.gear_item_id JOIN players p ON p.id=g.player_id`;
    const compute=async()=>{
      // For a build's pieces, count the rows ahead of each target in its slot's score index range.
      const statement=perSlot?Prisma.sql`
        SELECT target.gear_item_id AS id, (
          SELECT count(*)+1 FROM gear_scores s ${gearVisibility}
          WHERE s.track=target.track AND s.slot=target.slot AND NOT p.hidden ${regionFilter}
            AND s.score>=target.score
            AND (s.score>target.score OR (s.score=target.score AND (
              s.max_score>target.max_score OR (s.max_score=target.max_score AND s.gear_item_id<target.gear_item_id)
            )))
        ) AS rank
        FROM gear_scores target JOIN gear_items g ON g.id=target.gear_item_id JOIN players p ON p.id=g.player_id
        WHERE target.track=${track} AND target.gear_item_id IN (${Prisma.join(uniqueIds)}) AND NOT p.hidden
          ${region?Prisma.sql`AND target.region=${region}`:Prisma.empty}`:Prisma.sql`
        SELECT ranked.id,ranked.rank FROM (
          SELECT ${id} AS id,row_number() OVER (ORDER BY s.score DESC,s.max_score DESC,${id} ASC) AS rank
          FROM ${table} s ${gear?gearVisibility:Prisma.sql`JOIN players p ON p.id=s.player_id`}
          WHERE s.track=${track} AND NOT p.hidden ${regionFilter}
            ${!gear?Prisma.sql`AND cardinality(s.gear_ids)>0`:Prisma.empty}
            ${gear&&query.slot?Prisma.sql`AND s.slot=${query.slot}`:Prisma.empty}
        ) ranked WHERE ranked.id IN (${Prisma.join(uniqueIds)})`;
      const rows=await this.prisma!.$queryRaw<{id:string;rank:bigint}[]>(statement);
      return Object.fromEntries(rows.map(row=>[row.id,Number(row.rank)]));
    };
    return this.cache?this.cache.getRankMap([board,track,region,perSlot?null:query.slot??null,perSlot,uniqueIds],compute):compute();
  }

  /** Place the equipped snapshot instead of this owner's best set, using the board's exact tie order. */
  async equippedRanks(playerId:string,track:string,role:'dps'|'healer'|'tank',row:{score:number;maxScore:number},region:string|null) {
    const prisma=this.prisma;
    if(!prisma)return {available:false as const};
    const base:Prisma.PlayerScoreWhereInput={...trackFilter(track,role),playerId:{not:playerId},player:{hidden:false},gearIds:{isEmpty:false}};
    const tie={playerId:{lt:playerId}};
    // Preserve owner exclusion when the final tie clause compares player ids.
    const [global,regional]=await prisma.$transaction(async tx=>{
      const rank=(scope:Prisma.PlayerScoreWhereInput)=>this.rank(where=>tx.playerScore.count({where}),scope,row,tie);
      return Promise.all([rank(base),region?rank({...base,region}):Promise.resolve(null)]);
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
    return {available:true as const,global,region:region&&regional?{code:region,rank:regional}:null};
  }

  /**
   * One page of a gear board. `total`: rows of the whole board with these filters (and this search), on the first
   * page only; later pages skip the count. Unsearched ranks are positions on the board (offset + index).
   */
  async gear(query:RankingQuery,options:{refresh?:boolean}={}):Promise<{available:boolean;entries:GearTopEntry[];total?:number;overall?:number;databaseEmpty?:boolean}> {
    if(query.dataset==='pioneer')return this.pioneer?.gear(query)??{available:false,entries:[]};
    return this.cache
      ? this.cache.getOrCompute(query,()=>this.computeGear(query),{...options,board:'gear'})
      : this.computeGear(query);
  }

  private async computeGear(query:RankingQuery):Promise<{available:boolean;entries:GearTopEntry[];total?:number;overall?:number;databaseEmpty?:boolean}> {
    const prisma=this.prisma;
    if(!prisma)return {available:false,entries:[]};
    const offset=query.offset??0;
    const base={...trackFilter(query.track,query.role),...(query.slot?{slot:query.slot}:{}),...(query.region?{region:query.region}:{}),gear:{player:{hidden:false}}};
    const verified=query.verified?{gearItemId:{in:await this.verifiedIds('gear',query)}}:{};
    const search=query.q?{OR:[{gear:{player:playerSearch(query.q)}},...(query.slots?[{slot:{in:query.slots}}]:[])]}:{};
    const count=offset?Promise.resolve(undefined):prisma.gearScore.count({where:{...base,...search,...verified}});
    const sameCount=query.track==='all'&&!query.slot&&!query.region&&!query.q&&!query.verified;
    const [rows,total,overall]=await Promise.all([prisma.gearScore.findMany({where:{...base,...search,...verified},orderBy:[...(query.sort==='aug'||query.sort==='aug-asc'?[{gear:{augmentCount:{sort:query.sort==='aug'?'desc' as const:'asc' as const,nulls:'last' as const}}}]:[]),...(query.sort==='name-asc'||query.sort==='name-desc'?[{gear:{player:{nickname:query.sort==='name-asc'?'asc' as const:'desc' as const}}}]:[]),{score:query.sort==='grv-asc'?'asc':'desc'},{maxScore:query.sort==='grv-asc'?'asc':'desc'},{gearItemId:query.sort==='grv-asc'?'desc':'asc'}],skip:offset,take:query.limit,
      include:{gear:{include:{player:true}}}}),count,
      offset?Promise.resolve(undefined):sameCount?count:prisma.gearScore.count({where:{...trackFilter('all',query.role),gear:{player:{hidden:false}}}})]);
    // Every piece that ranks on some board of this role (its "all elements" row), whatever the region, slot and search:
    // with every filter on All both numbers are equal. Pieces with nothing for the role (e.g. only HP and resistances
    // for DPS) are not counted here (2026-10-08).
    const ranks=query.q||query.verified||query.places==='global'||(query.sort&&query.sort!=='grv')?await this.storedRanks('gear',query,rows.map(row=>row.gearItemId)):null;
    const databaseEmpty=offset?undefined:overall===0?!(await prisma.gearItem.findFirst({select:{id:true}})):false;
    return {available:true,...(total!==undefined?{total,overall,databaseEmpty}:{}),entries:rows.map((row,index)=>({rank:ranks?.[row.gearItemId]??offset+index+1,score:row.score,maxScore:row.maxScore,track:pageTrack(row.sourceTrack??row.track),
      player:{nickname:row.gear.player.nickname,uid:row.gear.player.uid,region:row.gear.player.region,serverId:row.gear.player.serverId},
      gear:gearView(row.gear)}))};
  }

  /**
   * Place a `score` (percent of the ceiling) would take on a board with these filters: visible rows above it, plus one.
   * Used for full-Titan projections: a build's potential (players) and an item's Titan maximum (gear) (2026-10-08).
   */
  async boardRank(board:'gear'|'players',query:RankingQuery,score:number):Promise<{available:boolean;rank?:number}> {
    if(!Number.isFinite(score)||score<0||score>1000)throw new BadRequestException('Invalid score');
    if(query.dataset==='pioneer') {
      const result=board==='gear'?await this.pioneer?.gear({...query,offset:0,limit:100}):await this.pioneer?.players({...query,offset:0,limit:100});
      return result?.available?{available:true,rank:1+result.entries.filter(row=>row.score>score).length}:{available:false};
    }
    const prisma=this.prisma;
    if(!prisma)return {available:false};
    const filters={...trackFilter(query.track,query.role),...(query.region&&query.places!=='global'?{region:query.region}:{}),score:{gt:score}};
    const above=board==='gear'
      ?await prisma.gearScore.count({where:{...filters,...(query.slot?{slot:query.slot}:{}),gear:{player:{hidden:false}}}})
      :await prisma.playerScore.count({where:{...filters,player:{hidden:false},gearIds:{isEmpty:false}}});
    return {available:true,rank:above+1};
  }

  /**
   * Gear-board places of stored pieces (a player's build, 2026-10-08): for each id, its rank on the board of its own slot
   * with this track, role and region, ordered as the board (score, then ceiling). Pieces without a row are left out.
   */
  async gearRanks(query:RankingQuery,ids:string[]):Promise<{available:boolean;ranks?:Record<string,number>}> {
    if(ids.length>24||ids.some(id=>!/^[0-9a-f-]{36}$/.test(id)))throw new BadRequestException('Invalid ids');
    if(query.dataset==='pioneer') {
      const result=await this.pioneer?.gear({...query,slot:undefined,offset:0,limit:100});
      return result?.available?{available:true,ranks:Object.fromEntries(result.entries.filter(row=>ids.includes(row.gear.id)).map(row=>[row.gear.id,1]))}:{available:false};
    }
    const prisma=this.prisma;
    if(!prisma)return {available:false};
    return {available:true,ranks:await this.storedRanks('gear',query,ids,true)};
  }

  /** One page of a player board; `total` as for gear (first page only). */
  async players(query:RankingQuery, options: {refresh?: boolean} = {}):Promise<{available:boolean;entries:PlayerTopEntry[];total?:number;overall?:number;databaseEmpty?:boolean}> {
    if(query.dataset==='pioneer')return this.pioneer?.players(query,options)??{available:false,entries:[]};
    if(this.cache) {
      return this.cache.getOrCompute(query,()=>this.computePlayers(query),options);
    }
    return this.computePlayers(query);
  }

  private async computePlayers(query:RankingQuery):Promise<{available:boolean;entries:PlayerTopEntry[];total?:number;overall?:number;databaseEmpty?:boolean}> {
    if(query.dataset==='pioneer')return this.pioneer?.players(query)??{available:false,entries:[]};
    const prisma=this.prisma;
    if(!prisma)return {available:false,entries:[]};
    const offset=query.offset??0;
    // A score row without any piece behind it (a player whose gear is gone) ranks nowhere (2026-10-08).
    const base={...trackFilter(query.track,query.role),...(query.region?{region:query.region}:{}),player:{hidden:false},gearIds:{isEmpty:false}};
    const verified=query.verified?{playerId:{in:await this.verifiedIds('players',query)}}:{};
    const where:Prisma.PlayerScoreWhereInput={...base,...verified,...(query.q?{player:{hidden:false,...playerSearch(query.q)}}:{})};
    // CS changes only display order. The rank below always counts the original GRV board, without verified/search.
    const csIds=(query.sort==='cs'||query.sort==='cs-asc')?await prisma.$queryRaw<{id:string}[]>(Prisma.sql`SELECT s.player_id AS id
      FROM player_scores s JOIN players p ON p.id=s.player_id WHERE s.track=${base.track} AND NOT p.hidden
      AND cardinality(s.gear_ids)>0 ${query.region?Prisma.sql`AND s.region=${query.region}`:Prisma.empty}
      ${query.verified?Prisma.sql`AND s.player_id IN (${Prisma.join(verified.playerId?.in.length?verified.playerId.in:[''])})`:Prisma.empty}
      ${query.q?Prisma.sql`AND s.player_id IN (${Prisma.join((await prisma.player.findMany({where:playerSearch(query.q),select:{id:true}})).map(row=>row.id).concat(''))})`:Prisma.empty}
      ORDER BY coalesce(p.max_combat_score,p.combat_score) ${query.sort==='cs-asc'?Prisma.sql`ASC`:Prisma.sql`DESC`} NULLS LAST,s.score DESC,s.max_score DESC,s.player_id ASC
      LIMIT ${query.limit} OFFSET ${offset}`):null;
    const [rows,total,overall]=await Promise.all([prisma.playerScore.findMany({where:csIds?{...where,playerId:{in:csIds.map(row=>row.id)}}:where,
      ...(csIds?{}:{skip:offset,take:query.limit}),
      orderBy:[...(query.sort==='name-asc'||query.sort==='name-desc'?[{player:{nickname:query.sort==='name-asc'?'asc' as const:'desc' as const}}]:[]),{score:query.sort==='grv-asc'?'asc':'desc'},{maxScore:query.sort==='grv-asc'?'asc':'desc'},{playerId:query.sort==='grv-asc'?'desc':'asc'}],include:{player:{include:{gear:true}}}}),
      offset?Promise.resolve(undefined):prisma.playerScore.count({where}),
      offset?Promise.resolve(undefined):prisma.player.count({where:{hidden:false,gear:{some:{}}}})]);
    // Every visible stored player with at least one piece, whatever the filters. A player seen only in duel gear (or
    // without equipment) stays stored but ranks nowhere and is not counted (2026-10-08, East13).
    if(csIds){const order=new Map(csIds.map((row,index)=>[row.id,index]));rows.sort((a,b)=>order.get(a.playerId)!-order.get(b.playerId)!);}
    const ranks=query.q||query.verified||query.places==='global'||(query.sort&&query.sort!=='grv')?await this.storedRanks('players',query,rows.map(row=>row.playerId)):null;
    const databaseEmpty=offset?undefined:overall===0?!(await prisma.gearItem.findFirst({select:{id:true}})):false;
    const testServers=await this.testAccounts?.forUids(rows.map(row=>row.player.uid));
    return {available:true,...(total!==undefined?{total,overall,databaseEmpty}:{}),entries:rows.map((row,index)=>{
      // The pieces behind this score; rows written before 2026-10-08 list none and show the equipped set.
      const ids=new Set(row.gearIds??[]),gear=row.player.gear.filter(item=>ids.size?ids.has(item.id):item.equipped);
      return {verified:!!row.player.selfCaptureAt,rank:ranks?.[row.playerId]??offset+index+1,score:row.score,maxScore:row.maxScore,track:pageTrack(row.sourceTrack??row.track),buildId:row.buildId,
      // The date the gear was last seen in game (as asked for the ranking), not when the score row was recomputed.
      updatedAt:new Date(Math.max(...gear.map(item=>item.lastSeenAt.getTime()),0)||row.updatedAt.getTime()).toISOString(),player:{nickname:row.player.nickname,uid:row.player.uid,region:row.player.region,
        serverId:row.player.serverId,combatScore:row.player.combatScore,maxCombatScore:row.player.maxCombatScore,maxCombatScoreAt:row.player.maxCombatScoreAt?.toISOString()??null,
        testServers:row.player.uid?testServers?.get(row.player.uid)??[]:[]},gear:gear.map(gearView)};})};
  }
}
