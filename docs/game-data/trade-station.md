# MMO Trade Station

The MMO catalog at `/datamine/items/?mode=mmo` shows Trade Station reference
prices, listing ranges, availability, categories and rules. It uses client
reference data and dated observations from the Overseas station. The extraction
and rules build on [Dat3K's contribution](https://github.com/smilekritik/tof-hub-public/pull/5).

## Extraction and publication

`build-trade-station.ts` runs in the processor graph after the item mappings and
writes `datamine/trade-station/data/trade-station.json` in staging. The Items
normalizer joins by the exact game item ID. Trade-only rows get catalog numbers
after the last number in the item mapping. The catalog retains localized item
fields and publishes the trade metadata under `trade`.

The resulting locale catalogs are served as
`game-data/<locale>/runtime/items-mmo.json`. The help dialog reads
`game-data/en/runtime/items-trade-rules.json` for the category tree, English
rules, observation date and server time zone. Run the regular [game-data
pipeline](../pipeline.md) to generate the catalogs and referenced images.
Generated data and game media are supplied separately from Git.

An older item snapshot can load with unknown listing availability. A fresh
processor run reports the table path and row ID if required data is missing or
malformed. If the catalog is already generated and the raw PNGs are available,
the exporter can run its `media` step against that output directory.

## Raw evidence

Paths below are relative to the raw export root. The Trade Station table is
keyed by game item ID. The staging export includes hashes of the sources it
consumed.

| Source | Fields and use |
| --- | --- |
| `Hotta/Content/Resources/CoreBlueprints/DataTable/TradeLineItemStaticDataTable.json` | `TradeBasePrice.Amount` and `CurrencyType`, `PutAwardRange`, `SysTradePriceRatio`, `TradePriceMinDif`, `TradeQuality`, `Typeindex`, `bCanList`, `bCanSysAutoSell`, `bForceBind` and `SubTypeIndex` |
| `Hotta/Content/Resources/CoreBlueprints/DataAsset/DA_TradeLine.json` | `TradeLineMenuListArray` links sections to types and localization keys. `TradePreviewTimeMinutes`, `TradePutAwayTimeMinutes`, `TradeOpenHour_Region` and `TradeCloseHour_Region` describe availability. |
| `Hotta/Content/Resources/CoreBlueprints/DataTable/TradeShopLevelDataTable.json` | `TradeCapacity` by level. `PutawayPriceRatio` is recorded as evidence with unsettled semantics. |
| `Hotta/Content/Resources/CoreBlueprints/DataTable/Item/ItemConfigs.json` | `ItemName.TableId` and `ItemName.Key` resolve names. `ItemIcon`, `ItemQuality`, `ArtPackID` and `ItemType` describe the item and fragment badge. |
| `Hotta/Content/Resources/CoreBlueprints/{DataTable/cooking/CookingFoodDataTable,DataTable_MMO/cooking/CookingFoodDataTable_MMO}.json` | `ItemIcon` on cooking dishes absent from the item config. |
| `Hotta/Content/Resources/CoreBlueprints/DataTable/ArtPackDataTable.json` | `Icons[1]` and `Icons[2]` supply fallback hair art. |
| `Hotta/Content/Localization/Game/en/Game.json` | Section and type labels use `DA_TradeLine.TextContent.Key`. Item labels use the config key and can fall back to `ST_Item`. |

An archived export with no `DA_TradeLine` uses the exact English keys in
`scripts/game-processors/curated/tools/trade-station-rules.json`.
`TQ_COM` maps to `CA4DBFCE4DAECF03D76D3FBFE7B98437` (Normal Supply),
`TQ_RATE` to `1E407BC345737F5023ECB8B5D98EFF1E` (Rare Supply) and
`TQ_RATE_FASHION` to `0F02FAD244D8C92ACFDE0A925EAFD914` (Rare Skin Deco).
The type filter pairs the section with its index. Unlabeled types display
“Type N”. In that archive, Normal Supply uses 0, 1 and 3–9. Type 2 occurs in
Rare Supply and Rare Skin Deco.

Item icons prefer the catalog projection, then the client item thumbnail
and the cooking or art-pack fallback. For example, `fashion_dress_24_4`
has `ItemIcon.AssetPathName` under
`/Game/Resources/UI/shizhuang/Fashion_icon/item_fashion_icon/fashion_icon_dress_24`.
The currency bindings use `Hotta/Content/Resources/Icon/huobi/tradediamond.png`
and `Hotta/Content/Resources/Icon/huobi/jinbi.png` for Universal Crystals and Gold.
The media pass publishes their WebP projections.

The fragment badge uses `ItemType` such as `ITEM_TYPE_FIGHTPET_FRAGMENT` on
`fragment_FightPet_13` and `ITEM_TYPE_ARTIFACT_FRAGMENT` on
`fragment_artifact_ssr_001`. Where the item type is absent, the processor
uses the documented `frag_` or `mmo_frag_` ID pattern and keeps a parent
link only when the exact parent is present.

## Prices and rules

Listing bounds multiply the reference amount by `PutAwardRange.X` and `.Y`
and round half up to whole currency units. System-buy bounds apply
`SysTradePriceRatio` the same way and remain in the dataset.
`TradePriceMinDif` is the reference-relative increment. The client export
does not establish how the station enforces the grid.

The dated Overseas observations in the curated rules replace the client band
on matching rows. A band names either an id prefix (a few rows) or a section
(every row of one `TradeQuality`), and records the client values it was seen
against; a row whose client bounds, step or base amount no longer match keeps
its client band.

- `StrengthenStoneMMO_B*` opens -40% to +146% in 13.3333% steps. The band
  includes the station's displayed percent rungs and pins the 12 UC base
  amount the observation covered.
- `TQ_RATE_FASHION` (Rare Skin Deco) lists from 60% of the reference price
  (-60%) instead of the client's 35% (-65%). The +250% ceiling and the 10%
  step remain the client's, and only the floor was observed, so no percent
  rungs are recorded.

Each band carries its own `observedAt`, and the rows it overrides carry that
date into the item catalog.

Dat3K's export measured 1,081 rows with 669 listable. A separate archived
export with an unconfirmed version measured 1,006 rows with 760 listable.
These counts describe those exports. Future runs use the installed client.
The curated rules preserve the observed server clock (UTC+9), Gold listing
fee and 5% sale fee. Settlement rounding, level-specific fee semantics and
whether the price grid is enforced remain unverified.

The processor tests run with `pnpm test:processors`.
