/* eslint-disable @typescript-eslint/no-require-imports -- `node --test` loads this TypeScript source
   through `require()`; tsc rejects the same `.ts` specifier in an `import`. */
const test = require('node:test');
const assert = require('node:assert/strict');

// `node --test` resolves the TypeScript source through the explicit extension; the type import
// below keeps the helpers typed without asking TypeScript to accept that same specifier.
import type { TradeStationRules } from '../../../packages/contracts/src/trade-station';
import type { TradeTableRow } from './build-trade-station';
type TradeStationModule = typeof import('./build-trade-station');
const tradeStation: TradeStationModule = require('./build-trade-station.ts');
const { buildRow, buildSections, buildTradeStationDataset, createIconFallback, createItemResolver, fillMissingSections, roundHalfUp, siteIconUrl, stationCapacity, tradeCurrencyCode } =
  tradeStation;

const LISTING_ROW = {
  TradePriceWaveRangeArray: [{ DifLevel: 0, fRecycleRatio: 0.1 }],
  PutAwardRange: { X: 0.5, Y: 2.5 },
  TradePriceMinDif: 0.25,
  SysTradePriceRatio: { X: 0.9, Y: 1.2 },
  bCanSysAutoSell: true,
  SysTradeItemAmount: { X: 40, Y: 200 },
  TradeBasePrice: { CurrencyType: 'EHottaCurrencyType::TradeDiamond', Amount: 4 },
  TradeQuality: 'TQ_COM',
  Typeindex: 1,
  SubTypeIndex: 0,
  bCanList: true,
  bForceBind: false,
};

test('keeps raw group and type identifiers when an export lacks category labels', () => {
  assert.deepEqual(fillMissingSections([], { item: LISTING_ROW }), [
    { id: 'TQ_COM', name: 'TQ_COM', types: [{ index: 1, name: '#1' }] },
  ]);
  assert.deepEqual(fillMissingSections([{ id: 'TQ_COM', name: 'Supply', types: [] }], { item: LISTING_ROW }), [
    { id: 'TQ_COM', name: 'Supply', types: [{ index: 1, name: '#1' }] },
  ]);
});

test('resolves an item name from the client string table when ItemConfigs omits it', () => {
  const resolve = createItemResolver([], {}, { ST_Item: { Item_Cooking_1001: 'Fried mushrooms' } });
  assert.equal(resolve('item_Cooking_1001').name, 'Fried mushrooms');
  assert.equal(resolve('Item_Cooking_1002').name, null);
});

/** The curated Overseas band for the rare weapon-enhancement modules, rungs included. */
const WEAPON_BAND = {
  idPrefix: 'StrengthenStoneMMO_B',
  clientBand: { basePrice: 4, minRatio: 0.5, maxRatio: 2.5, stepRatio: 0.25 },
  minRatio: 0.6,
  maxRatio: 2.46,
  stepRatio: 0.1333333,
  percentRungs: [-40, -27, -13, 0, 13, 27, 40, 53, 67, 80, 93, 106, 120, 133, 146],
};

/** The curated Overseas floor for Rare Skin Deco, scoped by section instead of an id prefix. */
const FASHION_BAND = {
  section: 'TQ_RATE_FASHION',
  clientBand: { minRatio: 0.35, maxRatio: 3.5, stepRatio: 0.1 },
  minRatio: 0.4,
  maxRatio: 3.5,
  stepRatio: 0.1,
  observedAt: '2026-11-12',
};

const FASHION_ROW: TradeTableRow = {
  ...LISTING_ROW,
  PutAwardRange: { X: 0.35, Y: 3.5 },
  TradePriceMinDif: 0.1,
  TradeBasePrice: { CurrencyType: 'EHottaCurrencyType::TradeDiamond', Amount: 7980 },
  TradeQuality: 'TQ_RATE_FASHION',
  Typeindex: 1,
};

test('roundHalfUp rounds exact halves up and absorbs float drift', () => {
  assert.equal(roundHalfUp(2.5), 3);
  assert.equal(roundHalfUp(2.49), 2);
  assert.equal(roundHalfUp(0), 0);
  assert.equal(roundHalfUp(4 * 0.35), 1);
  assert.equal(roundHalfUp(4 * 2.5), 10);
  assert.equal(roundHalfUp(19800 * 3.5), 69300);
});

test('buildRow derives both price bands and carries the listing flags', () => {
  assert.deepEqual(buildRow('StrengthenStoneMMO_A2', LISTING_ROW, {
    name: 'Simple reconstruct component',
    icon: '/datamine/shared/media/Hotta/Content/Resources/Icon/item/x.webp',
    quality: 'ITEM_QUALITY_COMMON',
  }), {
    id: 'StrengthenStoneMMO_A2',
    name: 'Simple reconstruct component',
    icon: '/datamine/shared/media/Hotta/Content/Resources/Icon/item/x.webp',
    quality: 'ITEM_QUALITY_COMMON',
    section: 'TQ_COM',
    type: 1,
    basePrice: 4,
    minPrice: 2,
    maxPrice: 10,
    minRatio: 0.5,
    maxRatio: 2.5,
    canList: true,
    canSystemBuy: true,
    systemMinPrice: 4,
    systemMaxPrice: 5,
    bindOnPurchase: false,
    priceStep: 0.25,
    bandSource: 'client',
    shard: false,
    shardOfId: null,
  });
});

test('buildRow drops the version axis and treats missing flags as false', () => {
  const row = buildRow('item_Cooking_6001', {
    TradeBasePrice: { Amount: 36 },
    TradeQuality: 'TQ_COM',
    Typeindex: 9,
    SubTypeIndex: 3,
  }, { name: null, icon: '', quality: '' });

  assert.equal('version' in row, false);
  assert.equal(row.type, 9);
  assert.equal(row.canList, false);
  assert.equal(row.canSystemBuy, false);
  assert.equal(row.bindOnPurchase, false);
  assert.equal(row.name, null);
});

test('buildSections resolves labels by key, sorts types, and emits no version list', () => {
  const labels = {
    SECTION: 'Normal Supply',
    TYPE_B: 'Weapon Enhancement',
    TYPE_A: 'Equip',
  };
  const sections = buildSections([
    {
      TradeQuality: 'TQ_COM',
      TextContent: { Key: 'SECTION', SourceString: '普通作战物资' },
      ChildrenNode: [
        { Typeindex: 1, TextContent: { Key: 'TYPE_B' } },
        { Typeindex: 0, TextContent: { Key: 'TYPE_A' } },
      ],
    },
  ], labels);

  assert.deepEqual(sections, [
    {
      id: 'TQ_COM',
      name: 'Normal Supply',
      types: [
        { index: 0, name: 'Equip' },
        { index: 1, name: 'Weapon Enhancement' },
      ],
    },
  ]);
  assert.equal('versions' in sections[0], false);
});

test('createItemResolver keeps the catalog icon and the client name, then falls back', () => {
  const resolve = createItemResolver(
    [[
      { id: 'fromCatalog', name: 'Catalog Name', icon: '/catalog.webp', quality: 'ITEM_QUALITY_EPIC' },
      {
        id: 'fromLegacyRoot',
        icon: '/datamine/shared/media/Hotta/Content/Resources/Icon/item/x.webp',
        quality: 'ITEM_QUALITY_COMMON',
      },
    ]],
    {
      fromConfig: {
        ItemIcon: { AssetPathName: '/Game/Resources/Icon/ImitationGift/unlock6.unlock6' },
        ItemName: { TableId: '/Game/Resources/Text/ST_item.ST_Item', Key: 'unlock6_name' },
        ItemQuality: 'ITEM_QUALITY_LEGENDRY',
      },
      fromCatalog: {
        ItemName: { TableId: '/Game/Resources/Text/ST_item.ST_Item', Key: 'unlock6_name' },
      },
    },
    {
      ST_Item: { unlock6_name: 'Upgrade Drive - Lockhart' },
      '': { 'item_Cooking_6001_name': 'Baked Black Bread' },
    },
    (id) => (id === 'fromCooking' ? '/cooking.webp' : '')
  );

  // The catalog owns the site icon; the client localization owns the name it shows in game.
  assert.deepEqual(resolve('fromCatalog'), {
    name: 'Upgrade Drive - Lockhart',
    icon: '/catalog.webp',
    quality: 'ITEM_QUALITY_EPIC',
  });
  // The production-only media root is rewritten to the tree every checkout serves.
  assert.deepEqual(resolve('fromLegacyRoot'), {
    name: null,
    icon: '/game-assets/webp/Hotta/Content/Resources/Icon/item/x.webp',
    quality: 'ITEM_QUALITY_COMMON',
  });
  assert.deepEqual(resolve('fromConfig'), {
    name: 'Upgrade Drive - Lockhart',
    icon: '/game-assets/webp/Hotta/Content/Resources/Icon/ImitationGift/unlock6.webp',
    quality: 'ITEM_QUALITY_LEGENDRY',
  });
  assert.deepEqual(resolve('item_Cooking_6001'), { name: 'Baked Black Bread', icon: '', quality: '' });
  assert.deepEqual(resolve('nowhere'), { name: null, icon: '', quality: '' });
});

test('siteIconUrl moves only the production media root onto the served WebP tree', () => {
  assert.equal(siteIconUrl('/datamine/shared/media/Hotta/Content/Resources/Icon/item/x.webp'),
    '/game-assets/webp/Hotta/Content/Resources/Icon/item/x.webp');
  assert.equal(siteIconUrl('/game-assets/webp/Hotta/Content/Resources/Icon/item/x.webp'),
    '/game-assets/webp/Hotta/Content/Resources/Icon/item/x.webp');
  assert.equal(siteIconUrl(''), '');
});

test('buildTradeStationDataset derives the currency code, keeps table order, and embeds the rules', () => {
  const rules: TradeStationRules = {
    source: 'observed',
    observedAt: '2026-11-07',
    serverTimeZone: 'UTC+9',
    en: { sections: [{ title: 'Listing', items: ['There is no purchase limit.'] }] },
  };
  const sources = { 'TradeLineItemStaticDataTable.json': 'a'.repeat(64) };
  const dataset = buildTradeStationDataset({
    rows: {
      second: { ...LISTING_ROW, TradeBasePrice: { CurrencyType: 'EHottaCurrencyType::TradeDiamond', Amount: 10 } },
      first: LISTING_ROW,
    },
    sources,
    sections: [{ id: 'TQ_COM', name: 'Normal Supply', types: [] }],
    describe: () => ({ name: 'Item', icon: '', quality: '' }),
    rules,
  });

  assert.deepEqual(dataset.currency, { code: 'TradeDiamond', name: 'Universal Crystal' });
  assert.deepEqual(dataset.sources, sources);
  assert.deepEqual(dataset.rows.map((row) => row.id), ['second', 'first']);
  assert.deepEqual(dataset.rules, rules);

  delete dataset.rules;
  assert.equal('rules' in dataset, false);
});

test('tradeCurrencyCode rejects a table that mixes currencies', () => {
  assert.equal(tradeCurrencyCode({ a: LISTING_ROW }), 'TradeDiamond');
  assert.throws(() => tradeCurrencyCode({
    a: LISTING_ROW,
    b: { ...LISTING_ROW, TradeBasePrice: { CurrencyType: 'EHottaCurrencyType::Gold', Amount: 4 } },
  }), /2 different currencies/);
});

test('stationCapacity reports a per-level split instead of throwing', () => {
  assert.equal(stationCapacity({ 1: { TradeCapacity: 6 }, 2: { TradeCapacity: 6 } }), 6);

  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(stationCapacity({ 1: { TradeCapacity: 6 }, 2: { TradeCapacity: 9 } }), 6);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /capacity differs across 2 levels \(6, 9\)/);
});

test('a frag_ id is marked as a shard of the item it names', () => {
  const shard = buildRow('frag_imitation_extra_6', LISTING_ROW, {
    name: 'Huma: Iron Blade Shard',
    icon: '',
    quality: '',
  });
  assert.equal(shard.shard, true);
  assert.equal(shard.shardOfId, 'imitation_extra_6');

  const fashion = buildRow('mmo_frag_Mount_038', LISTING_ROW, { name: 'Jerry - 85 Shard', icon: '', quality: '' });
  assert.equal(fashion.shard, true);
  assert.equal(fashion.shardOfId, 'Mount_038');

  const plain = buildRow('imitation_extra_6', LISTING_ROW, { name: 'Huma: Iron Blade', icon: '', quality: '' });
  assert.equal(plain.shard, false);
  assert.equal(plain.shardOfId, null);

  // "fragment_artifact" names a shard but carries no `frag_` prefix to derive a parent from.
  const artifact = buildRow('fragment_artifact_ssr_001', LISTING_ROW, { name: 'Colossus Arm Shard', icon: '', quality: '' });
  assert.equal(artifact.shard, false);
  assert.equal(artifact.shardOfId, null);
});

test('a shard whose parent is absent from the table drops the parent link', () => {
  const dataset = buildTradeStationDataset({
    rows: { frag_MMOWeapon_mimi_thunder: LISTING_ROW },
    sources: {},
    sections: [],
    describe: (id) => ({ name: id, icon: '', quality: '' }),
    rules: null,
  });
  assert.equal(dataset.rows[0].shard, true);
  assert.equal(dataset.rows[0].shardOfId, null);
});

test('the item config classifies shards independently of the item ID prefix', () => {
  const resolve = createItemResolver([], {
    fragment_FightPet_13: {ItemType: 'ITEM_TYPE_FIGHTPET_FRAGMENT'},
    frag_container: {ItemType: 'ITEM_TYPE_CONTAINER'},
  }, {});
  const pet = buildRow('fragment_FightPet_13', LISTING_ROW, resolve('fragment_FightPet_13'));
  assert.equal(pet.shard, true);
  assert.equal(pet.shardOfId, null);
  assert.equal(buildRow('frag_container', LISTING_ROW, resolve('frag_container')).shard, false);
});

test('a catalog row without an icon defers to the client name and the fallback icon', () => {
  const resolve = createItemResolver(
    [[{ id: 'item_Cooking_3001', name: 'Blast the peppers.', icon: '', quality: '' }]],
    {},
    { ST_Item: { item_Cooking_3001_name: 'Stir-Fried Chilies' } },
    (id) => (id === 'item_Cooking_3001' ? '/caiyao/3001.webp' : '')
  );
  assert.deepEqual(resolve('item_Cooking_3001'), {
    name: 'Stir-Fried Chilies',
    icon: '/caiyao/3001.webp',
    quality: '',
  });
});

test('an item thumbnail takes precedence over the appearance art-pack fallback', () => {
  const resolve = createItemResolver([], {
    outfit: {ItemIcon: {AssetPathName: '/Game/Resources/Icon/item/thumbnail.thumbnail'}},
  }, {}, () => '/game-assets/webp/appearance.webp');
  assert.equal(resolve('outfit').icon, '/game-assets/webp/Hotta/Content/Resources/Icon/item/thumbnail.webp');
});

test('a curated catalog rename still wins over the client name', () => {
  const resolve = createItemResolver(
    [[{ id: 'x', name: 'auto', rename: 'Curated', icon: '/x.webp', quality: '' }]],
    { x: { ItemName: { TableId: 'S.ST_Item', Key: 'k' } } },
    { ST_Item: { k: 'Client Name' } }
  );
  assert.equal(resolve('x').name, 'Curated');
});

test('createIconFallback reads cooking rows, then the art pack a hair item points at', () => {
  const fallback = createIconFallback({
    cooking: { Item_Cooking_3001: { ItemIcon: { AssetPathName: '/Game/Resources/Icon/caiyao/3001.3001' } } },
    artPacks: {
      makeup_Hair_010: {
        Icons: [
          { AssetPathName: 'None' },
          { AssetPathName: '/Game/Resources/UI/makeup/hair/famale/zhengfa/21.21' },
          { AssetPathName: '/Game/Resources/UI/makeup/hair/male/1.1' },
        ],
      },
    },
    itemConfigs: { makeup_Hair_010: { ArtPackID: 'makeup_Hair_010' } },
  });
  // The cooking table keys rows with a capital I; the trade table uses a lowercase id.
  assert.equal(
    fallback('item_Cooking_3001'),
    '/game-assets/webp/Hotta/Content/Resources/Icon/caiyao/3001.webp'
  );
  assert.equal(
    fallback('makeup_Hair_010'),
    '/game-assets/webp/Hotta/Content/Resources/UI/makeup/hair/famale/zhengfa/21.webp'
  );
  assert.equal(fallback('unknown_id'), '');
});

test('a curated band replaces the client one and is marked as observed', () => {
  const row = buildRow('StrengthenStoneMMO_B_Fire', LISTING_ROW, {
    name: 'Enhanced Resonance Module - Burn',
    icon: '',
    quality: 'ITEM_QUALITY_EPIC',
  }, WEAPON_BAND);
  assert.equal(row.minRatio, 0.6);
  assert.equal(row.maxRatio, 2.46);
  // The 4 UC reference price of the fixture: 0.6 → 2.4 UC (2), 2.46 → 9.84 UC (10).
  assert.equal(row.minPrice, 2);
  assert.equal(row.maxPrice, 10);
  // The band carries the station's own 13.3333% interval, not the client's 13.3% one.
  assert.equal(row.priceStep, 0.1333333);
  assert.equal(row.bandSource, 'server');
});

test('buildTradeStationDataset applies an observed band only to matching IDs and client values', () => {
  const dataset = buildTradeStationDataset({
    rows: {
      StrengthenStoneMMO_B_Fire: LISTING_ROW,
      StrengthenStoneMMO_A2: LISTING_ROW,
      StrengthenStoneMMO_B_Ice: { ...LISTING_ROW, PutAwardRange: { X: 0.5, Y: 3 } },
    },
    sources: {},
    sections: [],
    describe: (id) => ({ name: id, icon: '', quality: '' }),
    rules: null,
    priceBands: [WEAPON_BAND],
  });
  const [banded, plain, updated] = dataset.rows;
  assert.equal(banded.bandSource, 'server');
  assert.equal(banded.maxRatio, 2.46);
  assert.equal(plain.bandSource, 'client');
  assert.equal(plain.maxRatio, 2.5);
  assert.equal(updated.bandSource, 'client');
  assert.equal(updated.maxPrice, 12);
});

test('a section band floors every matching row and stamps its observation date', () => {
  const dataset = buildTradeStationDataset({
    rows: {
      Mount_Racing_001: FASHION_ROW,
      Mount_019: { ...FASHION_ROW, TradeBasePrice: { CurrencyType: 'EHottaCurrencyType::TradeDiamond', Amount: 1280 } },
      fragment_FightPet_13: { ...FASHION_ROW, PutAwardRange: { X: 0.3, Y: 4 } },
      StrengthenStoneMMO_C_Fire: { ...LISTING_ROW, PutAwardRange: { X: 0.35, Y: 3.5 }, TradePriceMinDif: 0.1 },
    },
    sources: {},
    sections: [],
    describe: (id) => ({ name: id, icon: '', quality: '' }),
    rules: null,
    priceBands: [FASHION_BAND],
  });
  const [first, second, otherSignature, otherSection] = dataset.rows;
  assert.equal(first.bandSource, 'server');
  assert.equal(first.minRatio, 0.4);
  assert.equal(first.maxRatio, 3.5);
  // 7,980 × 0.4 = 3,192 UC, and 7,980 × 3.5 = 27,930 UC.
  assert.equal(first.minPrice, 3192);
  assert.equal(first.maxPrice, 27930);
  assert.equal(first.priceStep, 0.1);
  assert.equal(first.observedAt, '2026-11-12');
  // The observation covered the band edges only, so no rung labels are claimed.
  assert.equal('percentRungs' in first, false);
  // The section selector ignores the reference price: 1,280 × 0.4 = 512 UC.
  assert.equal(second.bandSource, 'server');
  assert.equal(second.minPrice, 512);
  // The client signature still guards the band: the 0.3-4 shard rows keep their client values.
  assert.equal(otherSignature.bandSource, 'client');
  assert.equal(otherSignature.minPrice, 2394);
  // A row outside the section keeps its client band even with the same client signature.
  assert.equal(otherSection.bandSource, 'client');
  assert.equal(otherSection.minRatio, 0.35);
  assert.equal(otherSection.minPrice, 1);
});

test('buildTradeStationDataset rejects missing listing fields and an unknown currency', () => {
  const build = (row: TradeTableRow) => buildTradeStationDataset({
    rows: { item: row },
    sources: {},
    sections: [],
    describe: (id) => ({ name: id, icon: '', quality: '' }),
    rules: null,
  });
  assert.throws(() => build({...LISTING_ROW, bCanList: undefined}), /invalid price, range or flags.*row item/);
  assert.throws(() => build({
    ...LISTING_ROW, TradeBasePrice: { CurrencyType: 'EHottaCurrencyType::Gold', Amount: 4 },
  }), /unsupported listing currency: Gold/);
});
