import {Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, forwardRef} from '@nestjs/common';
import {RaidCurrentNamesRequestSchema, RaidRankingDatasetSchema, ServerRegionCodeSchema, UNRANKED_REGION_CODES} from '@tof-hub/contracts';
import {latestRaidBoards} from '@tof-hub/game-domain';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {gameDataDirectory, loadScoringCatalog} from '../../players/scoring-catalog';
import {RankingCacheService, type CachedBoard} from './ranking-cache.service';
import {RankingService, type RankingQuery} from '../ranking.service';

type WarmupTarget = RankingQuery & {board?: CachedBoard};
const RAID_LOOKUP_BATCH = 500;
const FULL_WARMUP_PAUSE_MS = 250;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const raidBoardSchema = RaidRankingDatasetSchema.shape.boards.element;
const raidIdentifierSchema = RaidCurrentNamesRequestSchema.shape.identifiers.element;

export function nextDailyWarmup(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(3, 1, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export interface WarmupSummary {
  planned: number;
  warmed: number;
  skipped: number;
  failed: number;
  durationMs: number;
  revision: string;
  slowest: {target: string; durationMs: number}[];
}

@Injectable()
export class RankingCacheWarmupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RankingCacheWarmup');
  private isWarming = false;
  private pendingRun: {reason:string; mode?:'minimal'|'full'; force:boolean} | null = null;
  private pendingDebounceTimer: NodeJS.Timeout | null = null;
  private lastSummary: WarmupSummary | null = null;
  private destroyed = false;
  private dailyTimer: NodeJS.Timeout | null = null;
  private enabled() {return !this.destroyed && process.env.RANKING_WARMUP !== 'false' && process.env.RANKING_WARMUP_ENABLED !== 'false';}

  constructor(
    private readonly cache: RankingCacheService,
    @Inject(forwardRef(() => RankingService)) private readonly ranking: RankingService,
  ) {}

  onApplicationBootstrap() {
    if (!this.enabled()) {
      this.logger.log('Ranking cache warmup is disabled by configuration');
      return;
    }

    // Run warmup in background after 1.5 seconds so API startup completes immediately
    this.pendingDebounceTimer = setTimeout(() => {
      this.pendingDebounceTimer = null;
      void this.triggerWarmup('initial');
    }, 1500);
    this.pendingDebounceTimer.unref();
    this.scheduleDaily();
  }

  private scheduleDaily() {
    if (!this.enabled()) return;
    const next = nextDailyWarmup();
    this.logger.log(`Next forced ranking warmup: ${next.toISOString()} (03:01 UTC)`);
    this.dailyTimer = setTimeout(() => {
      this.scheduleDaily();
      void this.triggerWarmup('daily-03:01-utc', 'full', true);
    }, next.getTime() - Date.now());
    this.dailyTimer.unref();
  }

  onModuleDestroy() {
    this.destroyed = true;
    if (this.pendingDebounceTimer) clearTimeout(this.pendingDebounceTimer);
    if (this.dailyTimer) clearTimeout(this.dailyTimer);
  }

  async triggerWarmup(
    reason: string = 'manual',
    overrideMode?: 'minimal' | 'full',
    force = false,
  ): Promise<WarmupSummary | null> {
    if (!this.enabled() || !this.cache.isReady()) return null;
    if (this.isWarming) {
      this.logger.log(`Warmup already in progress, scheduling rerun once finished (${reason})`);
      const previous = this.pendingRun;
      this.pendingRun = {reason, mode:overrideMode === 'full' || previous?.mode === 'full' ? 'full' : overrideMode,
        force:force || previous?.force === true};
      return null;
    }

    this.isWarming = true;
    const start = Date.now();
    let revision: string;
    const mode = overrideMode || process.env.RANKING_WARMUP_MODE || 'minimal';
    let targets: WarmupTarget[];
    try {
      revision = await this.cache.getRevision();
      targets = this.getTargets(mode);
    } catch {this.isWarming = false; return null;}

    this.logger.log(
      `Starting ranking warmup (${reason}, mode: ${mode}, revision: v${revision}, targets: ${targets.length})`,
    );

    let warmed = 0;
    let skipped = 0;
    let failed = 0;
    const timings: WarmupSummary['slowest'] = [];

    try {
      for (const {board = 'players', ...query} of targets) {
        if (!this.enabled() || !this.cache.isReady()) return null;
        // Continue with the current revision without restarting the whole warmup.
        const currentRev = await this.cache.getRevision();
        if (currentRev !== revision) {
          this.logger.log(`Ranking changed during warmup (${revision} -> ${currentRev}); remaining queries use the current revision`);
          revision = currentRev;
        }

        let queryStartedAt: number | undefined;
        const target = `${query.dataset ?? 'live'}/${board} ${this.cache.canonicalQueryKey(query)}${query.slot ? ` slot=${query.slot}` : ''}`;
        try {
          const cached = force ? null : query.dataset === 'pioneer' ? await this.cache.hasSnapshot(query) : await this.cache.get(query, revision, board);
          if (cached) {
            skipped++;
            continue;
          }

          // Compute and cache
          queryStartedAt = Date.now();
          const result = board === 'gear' ? await this.ranking.gear(query, {refresh: force}) : await this.ranking.players(query, {refresh: force});
          if (result.available && (query.dataset === 'pioneer' ? await this.cache.hasSnapshot(query, force ? queryStartedAt : 0) : await this.cache.get(query, currentRev, board))) {
            this.cache.recordWarmup();
            warmed++;
          } else {failed++;}

        } catch (err: unknown) {
          failed++;
          this.logger.warn(`Warmup query failed for ${target}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          if (queryStartedAt !== undefined) timings.push({target, durationMs: Date.now() - queryStartedAt});
        }
        await pause(mode === 'full' ? FULL_WARMUP_PAUSE_MS : 20);
      }

      if (mode === 'full') await this.warmRaidNames();

      const durationMs = Date.now() - start;
      const slowest = timings.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
      this.lastSummary = {
        planned: targets.length,
        warmed,
        skipped,
        failed,
        durationMs,
        revision,
        slowest,
      };

      this.logger.log(
        `Ranking warmup completed in ${durationMs}ms (warmed: ${warmed}, skipped: ${skipped}, failed: ${failed}, revision: v${revision})`,
      );
      if (slowest.length) {
        this.logger.log(`Slowest warmup targets: ${slowest.map(({target, durationMs}) => `${target} ${durationMs}ms`).join(', ')}`);
      }

      return this.lastSummary;
    } catch (error) {
      this.logger.warn(`Warmup interrupted: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      this.isWarming = false;
      if (this.pendingRun && this.enabled()) {
        const pending = this.pendingRun;
        this.pendingRun = null;
        this.pendingDebounceTimer = setTimeout(() => {
          this.pendingDebounceTimer = null;
          void this.triggerWarmup(pending.reason, pending.mode, pending.force);
        }, 500);
        this.pendingDebounceTimer.unref();
      }
    }
  }

  private async warmRaidNames() {
    const startedAt = Date.now();
    const directory = join(gameDataDirectory(), 'handbook');
    try {
      const index = RaidRankingDatasetSchema.parse(JSON.parse(await fs.readFile(join(directory, 'runtime/raid-rankings.json'), 'utf8')));
      const boards = latestRaidBoards(index.boards).filter(board => board.scope.kind === 'region');
      const identifiers = new Set<string>();
      let failedBoards = 0;
      for (const board of boards) {
        try {
          const detail = board._detail && board.entries.length !== board.entryCount
            ? raidBoardSchema.parse(JSON.parse(await fs.readFile(join(directory, `${board._detail}.json`), 'utf8')))
            : board;
          if (detail.id !== board.id || detail.seasonId !== board.seasonId || detail.sourceId !== board.sourceId
            || (board.entryCount !== undefined && detail.entries.length !== board.entryCount)) {
            throw new Error('Raid board does not match its index');
          }
          for (const entry of detail.entries) {
            for (const member of entry.members ?? []) {
              const identifier = raidIdentifierSchema.safeParse(member.identifier);
              if (identifier.success) identifiers.add(identifier.data);
            }
          }
        } catch {
          failedBoards++;
        }
      }

      const ids = [...identifiers];
      let found = 0;
      let failedBatches = 0;
      for (let offset = 0; offset < ids.length; offset += RAID_LOOKUP_BATCH) {
        if (!this.enabled() || !this.cache.isReady()) return;
        try {
          const result = await this.ranking.currentPlayerNames(ids.slice(offset, offset + RAID_LOOKUP_BATCH));
          if (result.available) found += result.entries.length;
          else failedBatches++;
        } catch {
          failedBatches++;
        }
        await pause(FULL_WARMUP_PAUSE_MS);
      }
      this.logger.log(`Raid nickname warmup completed in ${Date.now() - startedAt}ms: ${new Set(boards.map(board => board.seasonId)).size} seasons, ${found}/${ids.length} names, ${failedBoards} board errors, ${failedBatches} batch errors`);
    } catch (err) {
      this.logger.warn(`Raid nickname warmup skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getLastSummary(): WarmupSummary | null {
    return this.lastSummary;
  }

  private getTargets(mode: string): WarmupTarget[] {
    // 1. High-priority combinations (loaded instantly)
    const priority: WarmupTarget[] = [
      { track: 'all', role: 'dps', dataset: 'pioneer', limit: 100 },
      { track: 'all', role: 'dps', limit: 50 },
      { track: 'all', role: 'dps', limit: 100 },
      { track: 'all', role: 'dps', limit: 50, verified: true },
      { track: 'all', role: 'dps', limit: 100, verified: true },
      // Keep startup warmup limited to the default gear board.
      { board: 'gear', track: 'all', role: 'dps', limit: 100 },
      { track: 'Physical-Flame', role: 'dps', region: 'AP', limit: 50 },
      { track: 'Physical-Flame', role: 'dps', region: 'AP', limit: 100 },
      { track: 'Frost-Volt', role: 'dps', region: 'AP', limit: 50 },
      { track: 'Frost-Volt', role: 'dps', region: 'AP', limit: 100 },
      { track: 'Frost', role: 'dps', limit: 50 },
      { track: 'Volt', role: 'dps', limit: 50 },
      { track: 'Flame', role: 'dps', limit: 50 },
      { track: 'Physical', role: 'dps', limit: 50 },
    ];

    if (mode === 'minimal') {
      return priority;
    }

    // 2. Full warmup: first pages for valid roles, tracks and regions.
    const catalog = loadScoringCatalog();
    const tracks = catalog
      ? ['all', ...catalog.tracks.map((t) => t.join('-'))]
      : ['all', 'Frost', 'Volt', 'Flame', 'Physical', 'Altered', 'Physical-Flame', 'Frost-Volt'];

    const rankedRegions = [...ServerRegionCodeSchema.options].filter(
      (code) => !UNRANKED_REGION_CODES.includes(code),
    );
    const regions = [undefined, ...rankedRegions]; // undefined = all regions

    const fullTargets: WarmupTarget[] = [...priority];
    const targetKey = (q: WarmupTarget) => `${q.dataset ?? 'live'}:${q.board ?? 'players'}:${this.cache.canonicalQueryKey(q)}:${q.slot ?? ''}`;
    const seen = new Set(priority.map(targetKey));
    const add = (query: WarmupTarget) => {
      const key = targetKey(query);
      if (seen.has(key)) return;
      seen.add(key);
      fullTargets.push(query);
    };

    // Also keep the global DPS top-50 used by existing clients.
    for (const track of tracks) {
      add({ track, role: 'dps', limit: 50 });
    }

    for (const role of ['dps','healer','tank'] as const) {
      for (const track of tracks) {
        if (role === 'tank' && track.includes('-')) continue;
        for (const region of regions) {
          const query = {track, role, limit:100, ...(region ? {region} : {})};
          add(query);
          add({board:'gear', ...query});
        }
        add({track, role, dataset:'pioneer', limit:100});
      }
    }
    for (const slot of Object.keys(catalog?.allowedStats ?? {})) {
      add({board:'gear', track:'all', role:'dps', slot, limit:100});
    }
    return fullTargets;
  }
}
