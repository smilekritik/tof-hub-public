/**
 * build-trade-station.js
 *
 * Trade Station listing table -> `datamine/trade-station/data/trade-station.json`.
 *
 * - `TradeLineItemStaticDataTable` has one row per sellable item id: the reference price in
 *   Universal Crystals (`TradeBasePrice`), the player listing band (`PutAwardRange`), the system buy
 *   band (`SysTradePriceRatio`) and the listing flags. Both bands are ratios of the reference price,
 *   so the four published prices are half-up rounded integers derived here.
 * - `DA_TradeLine.TradeLineMenuListArray` is the section/type catalog tree. Its labels are 32-hex
 *   localization keys resolved from the English `Game.json` root namespace; `SourceString` is the
 *   CN text and is never used.
 * - `TradeShopLevelDataTable` is reported for the capacity the curated rules quote.
 * - Item identity comes from the item catalogs, then `ItemConfigs` + the English `Game.json`. An id
 *   that resolves nowhere keeps `name: null` and is listed in the processor report. Catalog icons
 *   keep their file but move to the served WebP root, so the published dataset loads in a checkout
 *   that has no `/datamine/shared/media` tree.
 *
 * The published shape lives in `@tof-hub/contracts` (`trade-station.ts`), shared with the page.
 *
 * Every field stays English, which is why this processor reads `Localization/Game/en/Game.json`
 * directly instead of following the locale projection the other processors share.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  TradePriceBand,
  TradeSection,
  TradeStationDataset,
  TradeStationRow,
  TradeStationRules,
} from '../../../packages/contracts/src/trade-station';

// The rule generator discovers these literal table paths even if the traced export lacks one.
const LISTING_TABLE = 'Hotta/Content/Resources/CoreBlueprints/DataTable/TradeLineItemStaticDataTable.json';
const CATEGORY_TREE = 'Hotta/Content/Resources/CoreBlueprints/DataAsset/DA_TradeLine.json';
const LEVEL_TABLE = 'Hotta/Content/Resources/CoreBlueprints/DataTable/TradeShopLevelDataTable.json';
const ITEM_CONFIGS = 'Hotta/Content/Resources/CoreBlueprints/DataTable/Item/ItemConfigs.json';
const COOKING_FOOD = 'Hotta/Content/Resources/CoreBlueprints/DataTable/cooking/CookingFoodDataTable.json';
const COOKING_FOOD_MMO = 'Hotta/Content/Resources/CoreBlueprints/DataTable_MMO/cooking/CookingFoodDataTable_MMO.json';
const ART_PACK = 'Hotta/Content/Resources/CoreBlueprints/DataTable/ArtPackDataTable.json';
const ENGLISH_GAME = 'Hotta/Content/Localization/Game/en/Game.json';
const ITEM_CATALOGS = ['merged_mapping_with_original_mmo.json', 'merged_mapping_with_original.json'];

/** The client encodes the Trade Station currency as `EHottaCurrencyType::TradeDiamond`. */
const CURRENCY_PREFIX = 'EHottaCurrencyType::';
const CURRENCY_NAME = 'Universal Crystal';
/**
 * WebP tree the site serves in development and production alike. The production nginx also serves
 * `/datamine/shared/media`, but a local checkout has no such directory, so every icon is emitted
 * under this root: the catalog's own path is rewritten by `siteIconUrl`.
 */
const MEDIA_ROOT = '/game-assets/webp';

/** Absorbs binary-float drift (e.g. `4 * 0.35 === 1.4000000000000001`) before half-up rounding. */
const ROUNDING_EPSILON = 1e-9;

const OUTPUT = path.join('datamine', 'trade-station', 'data', 'trade-station.json');
const RULES_FILE = 'trade-station-rules.json';

type LocalizationTable = Record<string, Record<string, string>>;

export interface TradeTextContent {
  Key?: string;
  SourceString?: string;
}

export interface TradeTreeCategoryNode {
  TextContent?: TradeTextContent;
  Typeindex?: number;
  TradeQuality?: string;
  ChildrenNode?: TradeTreeCategoryNode[];
}

export interface TradeTableRow {
  TradeBasePrice?: { CurrencyType?: string; Amount?: number };
  PutAwardRange?: { X?: number; Y?: number };
  SysTradePriceRatio?: { X?: number; Y?: number };
  TradePriceMinDif?: number;
  TradeQuality?: string;
  Typeindex?: number;
  SubTypeIndex?: number;
  bCanList?: boolean;
  bCanSysAutoSell?: boolean;
  bForceBind?: boolean;
}

interface IconRef {
  AssetPathName?: string;
}

interface ItemConfigRow {
  ItemIcon?: IconRef;
  ItemName?: { TableId?: string; Key?: string };
  ItemQuality?: string;
  ItemType?: string;
  /** Hair and other cosmetics point at an art pack instead of carrying their own icon. */
  ArtPackID?: string;
}

interface CatalogItem {
  id?: string;
  name?: string;
  icon?: string;
  quality?: string;
  /** A hand-written site name. Two rows in the whole catalog carry one; the rest are derived. */
  rename?: string;
}

export interface ItemIdentity {
  name: string | null;
  icon: string;
  quality: string;
  shard?: boolean;
}

/**
 * Shard ids carry a `frag_` segment. Stripping the prefix identifies a possible related row.
 */
const SHARD_PREFIXES = ['mmo_frag_', 'frag_'];

function shardParentId(id: string): string | null {
  const prefix = SHARD_PREFIXES.find((candidate) => id.startsWith(candidate));
  return prefix ? id.slice(prefix.length) : null;
}

interface SourceFile {
  data: unknown;
  sha256: string;
}

function option(name: string): string | null {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
  return hit ? path.resolve(hit.slice(name.length + 3)) : null;
}

/** Raw bytes and their digest, so `sources` hashes the exact file the pipeline consumed. */
function readSource(filePath: string, relative: string): SourceFile {
  if (!fs.existsSync(filePath)) throw new Error(`[required] Trade Station source missing: ${relative}`);
  const bytes = fs.readFileSync(filePath);
  return {
    data: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Client DataTables and DataAssets are saved as a one-entry array. */
function assetObject(source: SourceFile, relative: string): Record<string, unknown> {
  const candidate = Array.isArray(source.data) ? source.data[0] : source.data;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`[required] Trade Station source malformed: ${relative}`);
  }
  // Parsed JSON boundary: the export object is a flat property bag.
  return candidate as Record<string, unknown>;
}

function assetProperties(source: SourceFile, relative: string): Record<string, unknown> {
  const properties = assetObject(source, relative).Properties;
  if (!properties || typeof properties !== 'object') {
    throw new Error(`[required] Trade Station properties missing: ${relative}`);
  }
  // Parsed JSON boundary: the caller reads the fields it declares, each checked on use.
  return properties as Record<string, unknown>;
}

function tableRows<TRow>(source: SourceFile, relative: string): Record<string, TRow> {
  const rows = assetObject(source, relative).Rows;
  if (!rows || typeof rows !== 'object') throw new Error(`[required] Trade Station rows missing: ${relative}`);
  // Parsed JSON boundary: row shapes are declared by the TRow the caller asks for.
  return rows as Record<string, TRow>;
}

/** Half-up rounding; every derived price is a positive integer amount of Universal Crystals. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5 + ROUNDING_EPSILON);
}

function label(table: Record<string, string>, key: string | undefined): string {
  if (!key) return '';
  if (typeof table[key] === 'string') return table[key];
  const matches = Object.keys(table).filter((candidate) => candidate.startsWith(key));
  return matches.length === 1 ? table[matches[0]] ?? '' : '';
}

/**
 * Sections and their types in the tree's declared order. The version axis is deliberately absent:
 * measured on the client table, every listable `TQ_RATE_FASHION` row sits at `SubTypeIndex = 1`.
 */
export function buildSections(tree: TradeTreeCategoryNode[], labels: Record<string, string>): TradeSection[] {
  return tree
    .filter((node) => Boolean(node.TradeQuality))
    .map((node) => ({
      id: String(node.TradeQuality),
      name: label(labels, node.TextContent?.Key),
      types: (node.ChildrenNode ?? [])
        .map((child) => ({ index: Number(child.Typeindex ?? 0), name: label(labels, child.TextContent?.Key) }))
        .sort((a, b) => a.index - b.index),
    }));
}

/** A partial export can still group rows by their original enum and type index. */
export function fillMissingSections(sections: TradeSection[], rows: Record<string, TradeTableRow>, names: Record<string, string> = {}): TradeSection[] {
  const catalog = new Map(sections.map(section => [section.id, {
    name: section.name || names[section.id] || section.id,
    types: new Map(section.types.map(type => [type.index, type.name || `#${type.index}`])),
  }]));
  for (const row of Object.values(rows)) {
    if (!row?.TradeQuality) continue;
    const section = catalog.get(row.TradeQuality) ?? { name: names[row.TradeQuality] || row.TradeQuality, types: new Map<number, string>() };
    const index = row.Typeindex ?? 0;
    if (!section.types.has(index)) section.types.set(index, `#${index}`);
    catalog.set(row.TradeQuality, section);
  }
  return [...catalog].map(([id, section]) => ({
    id,
    name: section.name,
    types: [...section.types].map(([index, name]) => ({ index, name })).sort((a, b) => a.index - b.index),
  }));
}

export function buildRow(
  id: string,
  raw: TradeTableRow,
  item: ItemIdentity,
  override?: TradePriceBand
): TradeStationRow {
  const basePrice = Number(raw.TradeBasePrice?.Amount ?? 0);
  const minRatio = Number(override?.minRatio ?? raw.PutAwardRange?.X ?? 0);
  const maxRatio = Number(override?.maxRatio ?? raw.PutAwardRange?.Y ?? 0);
  const systemMinRatio = Number(raw.SysTradePriceRatio?.X ?? 0);
  const systemMaxRatio = Number(raw.SysTradePriceRatio?.Y ?? 0);
  const shardParent = item.shard === false ? null : shardParentId(id);
  return {
    id,
    name: item.name,
    icon: item.icon,
    quality: item.quality,
    section: String(raw.TradeQuality ?? ''),
    type: Number(raw.Typeindex ?? 0),
    basePrice,
    minPrice: roundHalfUp(basePrice * minRatio),
    maxPrice: roundHalfUp(basePrice * maxRatio),
    minRatio,
    maxRatio,
    canList: raw.bCanList === true,
    canSystemBuy: raw.bCanSysAutoSell === true,
    systemMinPrice: roundHalfUp(basePrice * systemMinRatio),
    systemMaxPrice: roundHalfUp(basePrice * systemMaxRatio),
    bindOnPurchase: raw.bForceBind === true,
    priceStep: Number(override?.stepRatio ?? raw.TradePriceMinDif ?? 0),
    ...(override?.percentRungs ? { percentRungs: override.percentRungs } : {}),
    ...(override?.observedAt ? { observedAt: override.observedAt } : {}),
    bandSource: override ? 'server' : 'client',
    shard: item.shard ?? (shardParent !== null),
    shardOfId: shardParent,
  };
}

/** `/Game/Resources/Icon/X/Y.Y` -> `/game-assets/webp/Hotta/Content/Resources/Icon/X/Y.webp`. */
function canonicalIconUrl(assetPath: unknown): string {
  if (typeof assetPath !== 'string' || !assetPath.startsWith('/Game/')) return '';
  const packagePath = assetPath
    .slice('/Game/'.length)
    .replace(/\.[^/.]*$/, '')
    .replace(/\.(?:png|webp|jpe?g|svg)$/i, '');
  return `${MEDIA_ROOT}/Hotta/Content/${packagePath}.webp`;
}

/**
 * The item catalogs store either the served WebP URL or the production-only media root; a consumer
 * of the published dataset must not inherit a path that 404s in a local checkout.
 */
export function siteIconUrl(url: string): string {
  const legacyRoot = '/datamine/shared/media/';
  return url.startsWith(legacyRoot) ? `${MEDIA_ROOT}/${url.slice(legacyRoot.length)}` : url;
}

function namespaceOf(tableId: string | undefined): string {
  const parts = String(tableId ?? '').split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

function localized(store: LocalizationTable, namespace: string, key: string | undefined): string | null {
  const value = key ? store[namespace]?.[key] : undefined;
  return typeof value === 'string' ? value : null;
}

/** Some ids (`item_Cooking_*`) have no `ItemConfigs` row; only the `<id>_name` key names them. */
function localizedByKey(store: LocalizationTable, key: string): string | null {
  for (const namespace of Object.values(store)) {
    const value = namespace[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

/**
 * Icons the client keeps outside `ItemConfigs`: cooking rows carry their own `ItemIcon`, and a hair
 * item names an `ArtPackID` whose `Icons` array holds the female icon, then the male one.
 */
export function createIconFallback(input: {
  cooking: Record<string, { ItemIcon?: IconRef }>;
  cookingMmo?: Record<string, { ItemIcon?: IconRef }>;
  artPacks?: Record<string, { Icons?: IconRef[] }>;
  itemConfigs: Record<string, ItemConfigRow>;
}): (id: string) => string {
  const cooking = new Map<string, string>();
  for (const table of [input.cooking, input.cookingMmo]) {
    for (const [id, row] of Object.entries(table ?? {})) {
      const url = canonicalIconUrl(row?.ItemIcon?.AssetPathName);
      if (url && !cooking.has(id.toLowerCase())) cooking.set(id.toLowerCase(), url);
    }
  }
  return (id) => {
    const fromCooking = cooking.get(id.toLowerCase());
    if (fromCooking) return fromCooking;
    const artPack = input.artPacks?.[input.itemConfigs[id]?.ArtPackID ?? ''];
    const icons = artPack?.Icons ?? [];
    for (const candidate of [icons[1], icons[2], icons[0]]) {
      const url = canonicalIconUrl(candidate?.AssetPathName);
      if (url) return url;
    }
    return '';
  };
}

/**
 * Item catalogs first (they carry the site icon and quality), then `ItemConfigs` + the locale
 * `Game.json`. A catalog row with no icon is an auto-derived entry whose name is usually a machine
 * translation, so that row defers to the client's own localization and icon.
 * An id that resolves nowhere keeps `name: null` so the processor can report it.
 */
export function createItemResolver(
  catalogs: CatalogItem[][],
  itemConfigs: Record<string, ItemConfigRow>,
  localization: LocalizationTable,
  fallbackIcon: (id: string) => string = () => ''
): (id: string) => ItemIdentity {
  const itemLabels = new Map(Object.entries(localization.ST_Item ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const catalogById = new Map<string, CatalogItem>();
  for (const catalog of catalogs) {
    for (const item of catalog) {
      const id = typeof item?.id === 'string' ? item.id : '';
      if (id && !catalogById.has(id)) catalogById.set(id, item);
    }
  }
  return (id) => {
    const catalogItem = catalogById.get(id);
    const catalogIcon = typeof catalogItem?.icon === 'string' ? catalogItem.icon : '';
    const config = itemConfigs[id];
    const configName = config
      ? localized(localization, namespaceOf(config.ItemName?.TableId), config.ItemName?.Key)
      : null;
    const clientName = configName ?? localizedByKey(localization, `${id}_name`) ?? itemLabels.get(id.toLowerCase());
    const quality =
      typeof catalogItem?.quality === 'string' && catalogItem.quality
        ? catalogItem.quality
        : typeof config?.ItemQuality === 'string'
          ? config.ItemQuality
          : '';

    // The catalog name is derived, and for ~100 ids it is a machine translation ("Blast the
    // peppers.", "Zip fragments."). A hand-written `rename` is the only name it owns.
    const rename = typeof catalogItem?.rename === 'string' ? catalogItem.rename : '';
    const name = rename || clientName || null;
    return {
      name,
      icon: catalogIcon ? siteIconUrl(catalogIcon) : canonicalIconUrl(config?.ItemIcon?.AssetPathName) || fallbackIcon(id),
      quality,
      ...(config?.ItemType ? { shard: /^ITEM_TYPE_(?:[A-Z0-9]+_)*FRAGMENT$/.test(config.ItemType) } : {}),
    };
  };
}

/** Every row settles in one currency; the code drops the enum prefix the client stores. */
export function tradeCurrencyCode(rows: Record<string, TradeTableRow>): string {
  const codes = new Set(Object.values(rows).map((row) => String(row.TradeBasePrice?.CurrencyType ?? '')));
  if (codes.size !== 1) {
    throw new Error(`[build-trade-station] rows settle in ${codes.size} different currencies`);
  }
  const [code] = [...codes];
  return code.startsWith(CURRENCY_PREFIX) ? code.slice(CURRENCY_PREFIX.length) : code;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidRange(range: TradeTableRow['PutAwardRange']): boolean {
  return isNonnegativeNumber(range?.X) && isNonnegativeNumber(range?.Y) && range.X <= range.Y;
}

/**
 * A band applies when its target matches and every recorded client value still matches the table,
 * so a client patch that changes the band stops the stale observation instead of silently keeping it.
 * A band records either an id prefix or a whole section, never both.
 */
function bandMatches(id: string, row: TradeTableRow, band: TradePriceBand): boolean {
  const targets = band.section
    ? row.TradeQuality === band.section
    : band.idPrefix ? id.startsWith(band.idPrefix) : false;
  if (!targets) return false;
  const { basePrice, minRatio, maxRatio, stepRatio } = band.clientBand;
  return (basePrice === undefined || row.TradeBasePrice?.Amount === basePrice)
    && row.PutAwardRange?.X === minRatio
    && row.PutAwardRange?.Y === maxRatio
    && row.TradePriceMinDif === stepRatio;
}

export function buildTradeStationDataset(input: {
  rows: Record<string, TradeTableRow>;
  sources: Record<string, string>;
  sections: TradeSection[];
  describe: (id: string) => ItemIdentity;
  rules: TradeStationRules | null;
  priceBands?: TradePriceBand[];
}): TradeStationDataset {
  const bands = input.priceBands ?? [];
  for (const [id, row] of Object.entries(input.rows)) {
    if (!row || !isNonnegativeNumber(row.TradeBasePrice?.Amount) || !isValidRange(row.PutAwardRange)
      || !isValidRange(row.SysTradePriceRatio) || !isNonnegativeNumber(row.TradePriceMinDif)
      || typeof row.bCanList !== 'boolean' || typeof row.bCanSysAutoSell !== 'boolean'
      || typeof row.bForceBind !== 'boolean') {
      throw new Error(`[build-trade-station] invalid price, range or flags in ${LISTING_TABLE} row ${id}`);
    }
  }
  const code = tradeCurrencyCode(input.rows);
  if (code !== 'TradeDiamond') {
    throw new Error(`[build-trade-station] unsupported listing currency: ${code || '(missing)'}`);
  }
  const bandFor = (id: string, row: TradeTableRow) => bands.find((band) => bandMatches(id, row, band));
  const dataset: TradeStationDataset = {
    currency: { code, name: CURRENCY_NAME },
    sources: input.sources,
    sections: input.sections,
    rows: Object.entries(input.rows).map(([id, raw]) => buildRow(id, raw, input.describe(id), bandFor(id, raw))),
  };
  // A shard only points at a parent the table also sells; the weapon shards have no such row.
  const ids = new Set(dataset.rows.map((row) => row.id));
  for (const row of dataset.rows) {
    if (row.shardOfId && !ids.has(row.shardOfId)) row.shardOfId = null;
  }
  if (input.rules) dataset.rules = input.rules;
  return dataset;
}

/**
 * Curated rules quote the station capacity. A client patch may vary it per level, so disagreement is
 * reported once instead of failing the dataset over a console line.
 */
export function stationCapacity(levels: Record<string, { TradeCapacity?: number }>): number {
  const capacities = [...new Set(Object.values(levels).map((level) => Number(level.TradeCapacity)))];
  if (capacities.length === 1) return capacities[0];
  console.warn(
    `[build-trade-station] Trade Station capacity differs across ${Object.keys(levels).length} levels ` +
    `(${capacities.join(', ')}); reporting level 1`
  );
  const levelOne = Number(levels['1']?.TradeCapacity);
  return Number.isFinite(levelOne) ? levelOne : capacities[0];
}

/**
 * The runner sets TOF_CURATED_DIR to the curated datamine folder. Its sibling
 * tools folder holds the Trade Station rules in both the repo and the packaged exporter.
 * `--rules-file` supplies an explicit file for standalone runs.
 */
function findRulesFile(explicit: string | null): string | null {
  const curatedRoot = process.env.TOF_CURATED_DIR;
  const candidates = [
    explicit,
    curatedRoot ? path.resolve(curatedRoot, '..', 'tools', RULES_FILE) : null,
    path.resolve(__dirname, '..', 'curated', 'tools', RULES_FILE),
    path.resolve(__dirname, 'curated', 'tools', RULES_FILE),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function readRules(filePath: string, sources: Record<string, string>) {
  const source = readSource(filePath, `curated/tools/${RULES_FILE}`);
  sources[`curated/tools/${RULES_FILE}`] = source.sha256;
  const { data } = source;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`[build-trade-station] curated rules are not an object: ${filePath}`);
  }
  // Parsed JSON boundary: the curated file is the documented rules contract.
  const { currencyAssets, categoryLabelKeys, ...rules } = data as TradeStationRules & {
    currencyAssets?: { trade: string; gold: string };
    categoryLabelKeys?: Record<string, string>;
  };
  if (!Array.isArray(rules.en?.sections)) {
    throw new Error(`[build-trade-station] curated rules are missing en.sections: ${filePath}`);
  }
  const fees = rules.fees;
  if (fees && (!Number.isFinite(fees.listingGoldPerUC) || fees.listingGoldPerUC < 0
      || !(fees.passDiscount >= 0 && fees.passDiscount <= 1)
      || !(fees.saleRatio >= 0 && fees.saleRatio <= 1))) {
    throw new Error(`[build-trade-station] invalid fee schedule: ${filePath}`);
  }
  for (const band of rules.priceBands ?? []) {
    const client = band.clientBand;
    const targets = Boolean(band.idPrefix) !== Boolean(band.section);
    if (!targets
      || (client?.basePrice !== undefined && !isNonnegativeNumber(client.basePrice))
      || !isValidRange({ X: client?.minRatio, Y: client?.maxRatio }) || !isNonnegativeNumber(client?.stepRatio)
      || !isValidRange({ X: band.minRatio, Y: band.maxRatio }) || !isNonnegativeNumber(band.stepRatio)
      || (band.percentRungs !== undefined && (!Array.isArray(band.percentRungs) || band.percentRungs.length < 2
        || !band.percentRungs.every(Number.isFinite)))
      || (band.observedAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(band.observedAt))) {
      throw new Error(
        `[build-trade-station] invalid client signature or price band ${band.idPrefix ?? band.section ?? '(no target)'}: ${filePath}`
      );
    }
  }
  return { rules, currencyAssets, categoryLabelKeys };
}

function readCatalogs(projectRoot: string, sources: Record<string, string>): CatalogItem[][] {
  return ITEM_CATALOGS.map((name) => {
    const relative = `datamine/items/data/${name}`;
    const file = path.join(projectRoot, relative);
    const { data: catalog, sha256 } = readSource(file, relative);
    sources[`stage/${relative}`] = sha256;
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
      throw new Error(`[required] item catalog malformed: ${file}`);
    }
    // Parsed JSON boundary: the catalog is a map of insertion index -> item.
    return Object.values(catalog as Record<string, CatalogItem>);
  });
}

function readLocalization(source: SourceFile, relative: string): LocalizationTable {
  if (!source.data || typeof source.data !== 'object' || Array.isArray(source.data)) {
    throw new Error(`[required] localization namespaces missing: ${relative}`);
  }
  return source.data as LocalizationTable;
}

function main(): void {
  const rawDir = option('raw-dir');
  const projectRoot = option('project-root');
  if (!rawDir || !projectRoot) {
    throw new Error('Usage: build-trade-station.js --raw-dir=<raw> --project-root=<stage>');
  }

  const sources: Record<string, string> = {};
  const readRaw = (relative: string) => {
    const source = readSource(path.join(rawDir, relative), relative);
    sources[`raw/${relative}`] = source.sha256;
    return source;
  };
  const optionalSource = (relative: string) => fs.existsSync(path.join(rawDir, relative)) ? readRaw(relative) : null;
  const listingSource = readRaw(LISTING_TABLE);
  const treeSource = optionalSource(CATEGORY_TREE);
  const levelSource = optionalSource(LEVEL_TABLE);

  // Parsed JSON boundary: the tree shape was verified against the client export.
  const menu = treeSource ? assetProperties(treeSource, CATEGORY_TREE).TradeLineMenuListArray : [];
  if (!Array.isArray(menu)) throw new Error(`TradeLineMenuListArray missing: ${CATEGORY_TREE}`);

  const rows = tableRows<TradeTableRow>(listingSource, LISTING_TABLE);
  const levels = levelSource ? tableRows<{ TradeCapacity?: number }>(levelSource, LEVEL_TABLE) : null;
  const itemConfigs = tableRows<ItemConfigRow>(readRaw(ITEM_CONFIGS), ITEM_CONFIGS);
  // Optional: a client build that drops the cooking or art-pack tables still gets a dataset, just
  // with those icons missing.
  const optionalRows = <TRow>(relative: string): Record<string, TRow> => {
    const source = optionalSource(relative);
    return source ? tableRows<TRow>(source, relative) : {};
  };
  const localization = readLocalization(readRaw(ENGLISH_GAME), ENGLISH_GAME);

  const rulesFile = findRulesFile(option('rules-file'));
  const curated = rulesFile ? readRules(rulesFile, sources) : null;
  const { currencyAssets, categoryLabelKeys, rules } = curated ?? {};
  if (!rulesFile) {
    console.warn('[build-trade-station] curated rules not found; emitting the dataset without a rules block');
  }
  const labels = localization[''] ?? {};
  const fallbackNames = Object.fromEntries(Object.entries(categoryLabelKeys ?? {}).map(([id, key]) => [id, label(labels, key)]));
  const sections = fillMissingSections(buildSections(menu as TradeTreeCategoryNode[], labels), rows, fallbackNames);
  if (!treeSource) console.warn(`[build-trade-station] category tree unavailable; using known section labels and raw type indices: ${CATEGORY_TREE}`);

  const dataset = buildTradeStationDataset({
    rows,
    sources,
    sections,
    describe: createItemResolver(
      readCatalogs(projectRoot, sources),
      itemConfigs,
      localization,
      createIconFallback({
        cooking: optionalRows<{ ItemIcon?: IconRef }>(COOKING_FOOD),
        cookingMmo: optionalRows<{ ItemIcon?: IconRef }>(COOKING_FOOD_MMO),
        artPacks: optionalRows<{ Icons?: IconRef[] }>(ART_PACK),
        itemConfigs,
      })
    ),
    rules: rules ?? null,
    priceBands: rules?.priceBands ?? [],
  });
  if (currencyAssets) {
    dataset.currency.icon = canonicalIconUrl(currencyAssets.trade);
    dataset.goldIcon = canonicalIconUrl(currencyAssets.gold);
  }

  const unnamed = dataset.rows.filter((row) => row.name === null).map((row) => row.id);
  if (unnamed.length > 0) {
    console.warn(`[build-trade-station] ${unnamed.length} rows without a name: ${unnamed.join(', ')}`);
  }

  const target = path.join(projectRoot, OUTPUT);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');

  const listable = dataset.rows.filter((row) => row.canList).length;
  const types = dataset.sections.reduce((total, section) => total + section.types.length, 0);
  console.log(
    `[build-trade-station] ${dataset.rows.length} rows (${listable} listable), ${dataset.sections.length} sections, ` +
    `${types} types, ${levels ? `capacity ${stationCapacity(levels)} over ${Object.keys(levels).length} levels` : 'capacity unavailable'}, ` +
    `${unnamed.length} unnamed, rules ${rulesFile ? path.basename(rulesFile) : 'absent'}.`
  );
}

// `require` exists in the pipeline's CommonJS build but not when `node --test` imports the helpers.
if (typeof require !== 'undefined' && require.main === module) {
  main();
}
