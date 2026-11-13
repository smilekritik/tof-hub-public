import {z} from 'zod';

/**
 * Staging shape emitted by build-trade-station and joined into the MMO item catalog.
 * See `docs/game-data/trade-station.md`.
 */
export interface TradeCurrency {
  /** `EHottaCurrencyType::` member the table trades in; the Overseas station uses `TradeDiamond`. */
  code: string;
  name: string;
  icon?: string;
}

/** A `Typeindex` or `SubTypeIndex` bucket with the label resolved from `DA_TradeLine`. */
export interface TradeTypeNode {
  index: number;
  name: string;
}

export interface TradeSection {
  /** `TradeQuality`, e.g. `TQ_COM`. Kept a plain string: a patch may add a section. */
  id: string;
  name: string;
  types: TradeTypeNode[];
}

export interface TradeRulesSection {
  title: string;
  items: string[];
}

/** A curated band the Overseas build uses instead of `PutAwardRange`. */
export interface TradePriceBand {
  /** Id prefix the band applies to; exactly one of `idPrefix` and `section` is set. */
  idPrefix?: string;
  /** `TradeQuality` the band applies to; exactly one of `idPrefix` and `section` is set. */
  section?: string;
  /**
   * Client values present when this server band was observed. `basePrice` is present only when the
   * observation covered one reference price, as on a single item family.
   */
  clientBand: { basePrice?: number; minRatio: number; maxRatio: number; stepRatio: number };
  minRatio: number;
  maxRatio: number;
  /** The interval between rungs, as the station measures it (13.3333%). */
  stepRatio: number;
  /** The price buttons the station shows inside the band, when the observation covered them. */
  percentRungs?: number[];
  /** The date this band was observed; the dataset rules' `observedAt` is the fallback. */
  observedAt?: string;
  note?: string;
}

export interface TradeStationRules {
  /** `client` when every band comes from `PutAwardRange`, `observed` when curated rules replace some. */
  source: 'client' | 'observed';
  observedAt: string;
  serverTimeZone: string;
  fees?: TradeFeeSchedule;
  /** Bands already applied to the rows; kept so the page can explain where a band came from. */
  priceBands?: TradePriceBand[];
  en: { sections: TradeRulesSection[] };
}

export type TradeStationRulesReference = Pick<TradeStationRules, 'observedAt' | 'serverTimeZone' | 'en'>;

export interface ItemTradeReference extends Partial<TradeStationRulesReference> {
  categories?: TradeSection[];
}

export interface TradeFeeSchedule {
  listingGoldPerUC: number;
  passDiscount: number;
  saleRatio: number;
}

export interface TradeStationRow {
  id: string;
  /** Null only if neither the item catalogs nor `ItemConfigs` name the id. */
  name: string | null;
  /** Served WebP URL under `/game-assets/webp/...`. */
  icon: string;
  quality: string;
  section: string;
  type: number;
  /** `TradeBasePrice.Amount`, in Universal Crystals. */
  basePrice: number;
  /** `round(basePrice × minRatio)`. */
  minPrice: number;
  /** `round(basePrice × maxRatio)`. */
  maxPrice: number;
  minRatio: number;
  maxRatio: number;
  canList: boolean;
  canSystemBuy: boolean;
  systemMinPrice: number;
  systemMaxPrice: number;
  bindOnPurchase: boolean;
  /** `TradePriceMinDif`: the minimum step between two prices, as a ratio of the reference price. */
  priceStep: number;
  /**
   * Where the band came from: `client` is `PutAwardRange`, `server` is a curated override for the
   * Overseas build that the client table cannot express.
   */
  bandSource: 'client' | 'server';
  /**
   * A curated band's price buttons, as the percents the station labels them with, bottom first.
   * Absent on client bands, whose ladder the view walks in whole UC steps.
   */
  percentRungs?: number[];
  /** The date the curated band that set this row was observed; the rules' `observedAt` is the fallback. */
  observedAt?: string;
  /** A row whose id starts with the client's `frag_` or `mmo_frag_` prefix. */
  shard: boolean;
  /** Related row identified by stripping the shard prefix, when that id exists in the table. */
  shardOfId: string | null;
}

export interface TradeStationDataset {
  currency: TradeCurrency;
  goldIcon?: string;
  /** SHA-256 digests keyed by the logical raw, stage or curated input path. */
  sources?: Record<string, string>;
  sections: TradeSection[];
  rows: TradeStationRow[];
  /** Curated rules for the Overseas MMO build; absent when the curated file is missing. */
  rules?: TradeStationRules;
}

/** Trade table observation joined to an MMO item by exact item ID. */
export const ItemTradeDataSchema = z.object({
  section: z.string(),
  type: z.number(),
  basePrice: z.number(),
  minPrice: z.number(),
  maxPrice: z.number(),
  minRatio: z.number(),
  maxRatio: z.number(),
  canList: z.boolean(),
  canSystemBuy: z.boolean(),
  systemMinPrice: z.number(),
  systemMaxPrice: z.number(),
  bindOnPurchase: z.boolean(),
  priceStep: z.number(),
  bandSource: z.enum(['client', 'server']),
  percentRungs: z.array(z.number()).optional(),
  shard: z.boolean(),
  shardOfId: z.string().nullable(),
  currency: z.object({code: z.string(), name: z.string(), icon: z.string().optional()}),
  observedAt: z.string().optional(),
});
export type ItemTradeData = z.infer<typeof ItemTradeDataSchema>;
