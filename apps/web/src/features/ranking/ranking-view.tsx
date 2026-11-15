'use client';
import { localized, localizedUi, translateUiText} from '@tof-hub/i18n';
import {localeText} from '@/lib/i18n/text';
import {scrollToSection} from '@/lib/scroll-to-section';
import {Fragment,createContext,memo,useCallback,useContext,useDeferredValue,useEffect,useMemo,useRef,useState,type CSSProperties,type ReactElement,type ReactNode} from 'react';
import Link from 'next/link';
import {GearSlotChips} from '../build/gear-slot-chips';
import {Button,CatalogControls,CatalogCounter,CatalogSearch,CatalogSort,Collapsible,EmptyState,FilterChip,FilterGroup,LoadingState,ModeSwitcher,Spinner,Toast,useToast,revealHorizontalFocus} from '@tof-hub/ui';
import {gameAsset} from '@tof-hub/game-assets';
import {getServerById,normalizeSearchText,SEALED_FILES} from '@tof-hub/contracts';
import {Hint,Nickname,RegionCell,RegionCode,RegionFilters} from '../players/player-identity';
import {useLocale} from '@/lib/i18n';
import {getPlayerRoleLabel,standardRVProfile} from '@tof-hub/game-domain';
import {queueMessage,type QueueJob} from '../queue/client';
import {submitSealedFile} from '../queue/sealed-upload';
import {QueueNotice} from '../queue/queue-notice';
import {RailGlyph,ToolRail} from '@/components/tool-rail/tool-rail';
import {CaptureAppModal} from '@/components/tool-rail/capture-app-modal';
import {InfoCard,SectionHeading} from '@/components/tool-rail/tool-info-modal';
import {UpdateDataModal} from './update-data-modal';
import {CalculationsModal} from '../build/build-info';
import {BuildInspection,BuildTooltip,Inspect,InspectionHeading} from '../build/build-inspection';
import {GearStatPreview} from '../build/gear-stat-preview';
import {GearStatChips} from '../build/gear-stat-chips';
import {Stars} from '../build/stars';
import {RollValueDot,RollValueMeter} from '../build/gear-roll-value';
import {augmentCountParts,augmentCountText,elementLabel,formatBuildDate,formatValue,gearStatOrder,rollValueQuality,rollValueStatGroup,statIcon,statLabel} from '../build/presentation';
import {ELEMENT_FILTER_OPTIONS,ROLE_FILTER_OPTIONS} from '../simulacra/constants';
import {getDualElementIconPath} from '../info-sections/common/element-icons';
import type {BuildLocale,GearDraft} from '../build/types';
import {type RankingRole,buildGain,gearGain,idealGearDraft,buildTitanMaximum,buildTrackScore,entryGear,topGearDraft,exampleGearTop,examplePlayerTop,gearCurrentScore,gearStageScores,gearStages,slotCeiling,idealGearTop,attackGearTop,resistanceGearTop,resistancePlayerTop,idealPlayerTop,attackPlayerTop,parseTrack,rankedTracks,scoringCatalog,trackId,ALL_TRACKS} from './scoring';
import type {ElementTrack,GearTopEntry,PlayerTopEntry,RankingBoard,RankingCatalog,RankingResponse} from './types';
import styles from './ranking.module.css';
import buildStyles from '../build/build.module.css';
import {formatFixed,formatNumber} from '@/lib/i18n/format';
import {hasKnownBuildBase,isVerifiedGear,isVerifiedPlayer} from './verification';
import {RankingResponseCache} from './response-cache';
import {useVisibleTitanFrames} from './use-visible-titan-frames';
import {includeOwnerEntries,useRankingOwner} from './use-ranking-owner';
import {rememberBrowserOwner} from '../players/browser-owner';
import type {BuildCapture} from '@tof-hub/contracts';

export interface RankingQueryState {board:RankingBoard;role:RankingRole;track:string;slot:string|null;region:string|null;
  dataset?:'pioneer';
  verified?:boolean;places?:'region'|'global';sort?:'grv'|'grv-asc'|'cs'|'cs-asc'|'aug'|'aug-asc'|'name-asc'|'name-desc'}
/** The board's role (DPS / healer / tank) for every score below the controls. */
const RoleContext=createContext<RankingRole>('dps');
/** Resistance icons on a tank board (null otherwise). */
/**
 * The perfect item / player under All (2026-10-08): one reference for every element (the ceilings are equal), drawn with
 * the Physical icon and its element stats named "Elemental" instead of a concrete element.
 */
const GenericElementContext=createContext(false);
const OwnPlayerContext=createContext<string|null>(null);
function useStatLabel(locale:BuildLocale) {
  const generic=useContext(GenericElementContext);
  return (type:string)=>statLabel(generic?type.replace(/^(Physical|Flame|Frost|Volt) /,'Elemental '):type,locale);
}
const ResistanceIconsContext=createContext<RankingCatalog['resistanceIcons']|null>(null);
/** Role switch: colours and icons of the Info Simulacra role filter (healer = Benediction). */
const RANKING_ROLE_OPTIONS=[{value:'dps',variant:'dps'},{value:'healer',variant:'benediction'},{value:'tank',variant:'tank'}] as const;
const LIMIT=100;
const FRAME_ANIMATION_STORAGE_KEY='tof-hub.ranking.gear-frame-animations.v1';
const EMPTY_ENTRIES:(GearTopEntry|PlayerTopEntry)[]=[];
/** Endless boards load the next page once this many rows remain below the screen. */
const LOAD_AHEAD=15;
/** Server search: from two characters, after a short pause; the API accepts up to 40 characters. */
const SEARCH_MIN=2,SEARCH_MAX=40,SEARCH_DELAY=300;

function useCopy(locale:BuildLocale) {
  // Stable per locale, so memoised rows keep their props between renders.
  return useMemo(()=>copyFor(locale),[locale]);
}
function copyFor(locale:BuildLocale) {
  const t=localeText(locale);
  return {t,
    title:t('Gear and player ranking'),filters:t('Ranking filters'),board:t('Ranking'),role:t('Role'),dps:getPlayerRoleLabel('dps',locale),healer:getPlayerRoleLabel('healer',locale),tank:getPlayerRoleLabel('tank',locale),
    searchPlaceholder:t('Search player, UID, server or item…'),clearSearch:t('Clear search'),
    showing:t('Showing'),of:t('of'),items:t('items','вещей'),
    verifiedOnly:t('Verified only'),places:t('Places'),regionalPlaces:t('In selected region'),globalPlaces:t('Overall'),
    displayOrder:t('Display order'),csOrderHint:t('Order by maximum CS; places remain the original GRV places.'),
    gear:t('Gear'),players:t('Players'),playersCount:t('players'),region:t('Region'),all:t('All'),
    element:t('Element','Стихия'),inheritance:t('With inheritance'),slot:t('Slot'),
    rank:'#',item:t('Item','Вещь'),player:t('Player'),rated:t('Rated stats'),grv:'GRV',
    original:t('Original'),originalHint:t('Values before Titan and roll counts'),
    now:t('Now'),nowHint:t('Current values and Titan progress'),
    knownBaseTitle:t('Verified Titan · own .tofbuild'),knownBaseBuildTitle:t('Verified'),knownBaseBuild:t('Imported capture'),knownBase:t('Titan item from the player’s own .tofbuild, with known original stats. Inspected and non-Titan gear is not verified.'),
    calculationsHelp:t('How ranking is calculated'),
    grvSourceTitle:'Global Roll Value',grvSourceRolls:t('Maximum roll weights'),
    grvSourceLead:t('One reference profile for everyone: each stat is rated by the damage it adds to the same reference player, so items and players compare fairly, independently of account stats.'),
    grvSourceAll:t('All: best native element or pair. Native matching takes priority over Altered at equal gear GRV; a lower slot ceiling alone cannot make Altered the winner. Altered is used when its gear points are strictly higher.'),
    grvSourceScore:t('Score','Оценка'),grvSourceContext:t('Context'),grvSourceTops:t('Ranking'),
    grvSourceUnit:t('Counted stats converted into rating points; 100 = the most valuable single roll at full Titan across all stats.'),
    grvSourceStats:t('universal ATK, the element’s ATK, ATK % and DMG %, Crit and Crit Rate %; other stats give 0.'),
    grvSourcePair:t('the better flat ATK, ATK % and DMG % of either element of the pair; Crit counts, other stats give 0.'),
    grvSourceCeiling:t('The perfect item of the slot: the best legal set of counted stats, every roll on the most valuable one, at full Titan (100 %).'),
    grvSourceCurrent:t('Current values of each item. Titan growth is random, so other players’ values before Titan cannot be recovered.'),
    grvSourcePlayer:t('Reference player'),
    grvSourceAssumption:t('These baseline values are site assumptions, not official game constants; crit uses the game’s crit formula at this enemy level.'),
    // Role variants of the GRV help (healer: ATK only; tank: effective HP against the element).
    grvSourceLeadHealer:t('One reference profile for everyone: each stat is rated by the ATK it adds to the same reference player (crit and DMG % are not rated).'),
    grvSourceLeadTank:t('One reference profile for everyone: each stat is rated by the effective HP it adds against the selected element to the same reference tank.'),
    grvSourceUnitRole:t('Counted stats converted into rating points; 100 = the most valuable single roll at full Titan among the stats this role rates.'),
    grvSourceStatsHealer:t('universal ATK, the element’s ATK and ATK %; crit, DMG % and other stats give 0.'),
    grvSourceStatsTank:t('HP, HP %, general RES (counts like the element’s own), the element’s RES and RES %; other stats give 0.'),
    grvSourceCeilingTank:t('The perfect item of the slot: the best legal set of stats on top, every roll on one of them, and the two best stats Titan can add below from that stat’s pools (HP and resistances carry its rolls), at full Titan (100 %).'),
    grvSourceAssumptionTank:t('These baseline values are site assumptions, not official game constants; damage reduction uses the game’s defence formula at this level.'),
    grvSourceHow:t('How the calculation works'),
    allElements:t('All elements · best element of each'),
    allPlayersElements:t('All elements · best element of each player'),
    allServersElements:t('All elements · best element of each server'),
    titanAdded:t('Added by Titan: this stat did not exist before Titan'),
    maxGrv:t('Max'),maxGrvHint:t('GRV of the perfect item of the slot (100 %)'),
    maxGrvBuildHint:t('Sum of the twelve slot ceilings (100 % build)'),
    growth:'%',titanShareHint:t('Titan growth so far: share of the way from the value before Titan to the full-Titan maximum (Titan-added stats: current value / maximum)'),
    max:t('Titan maximum'),maxHint:t('Every stat at its full-Titan ceiling'),
    added:t('Titan stats'),unknown:t('Unknown','Неизвестно'),rolls:t('rolls'),
    expand:t('Show details'),collapse:t('Hide details'),
    emptyTitle:t('The rankings are waiting for uploads'),
    emptyText:t('Rankings fill as players upload build cards from the capture app. Each upload counts once per character; hidden profiles never appear.'),
    unavailable:t('Rankings are not connected on this server yet.'),
    showExample:t('Show example'),hideExample:t('Hide example'),
    example:t('Example: the sample build card from Tools → Build, not a real upload.'),
    upload:t('Upload your build'),loading:t('Loading rankings…'),error:t('Could not load the rankings.'),
    total:t('Build GRV'),slots:t('Best known gear'),updated:t('Updated','Обновлено'),maxCsSeen:t('Max CS recorded'),
    uploadPlayers:t('Upload players (.tofplayers)').replace(SEALED_FILES.players.extension,`${SEALED_FILES.players.extension}, ${SEALED_FILES.build.extension}`),uploading:t('Uploading…'),
    uploadFailed:t('The players archive could not be imported'),
    blankName:'blank',
    blankNameHint:t('Invisible characters:'),
    nicknameCopied:t('Nickname copied'),
    ideal:t('Perfect item'),hideIdeal:t('Hide perfect item'),
    idealPlayer:t('Perfect player'),hideIdealPlayer:t('Hide perfect player'),
    reference:t('100 % reference'),
    alteredPercentItem:t('Altered RES% item'),alteredPercentReference:t('Five maximum rolls into Altered RES%'),
    resistanceItem:t('Only RES item'),resistancePlayer:t('Only RES player'),resistanceReference:t('No HP or HP% rolls'),otherResistance:t('Other RES stat'),
    attackItem:t('ATK% item'),attackGearReference:t('All rolls into ATK%'),
    attackPlayer:t('ATK% player'),attackReference:t('All rolls into ATK% where available'),
    idealHint:t('The 100 % item for this element: the best rated stats of the slot, every roll on the most valuable one, full Titan.'),
    anyStat:t('any stat'),anyStatExcept:t('any stat except'),
    currentGrv:t('GRV now'),
    nothingRated:t('No stat of this element on the item.'),
    flatAttack:t('ATK total'),potential:t('Titan potential'),potentialRank:t('on this board'),slotRankWord:t('Top'),slotRankHint:t('Place of this piece on the gear board of its slot, with this element, role and region.'),potentialHint:t('Every piece of this build at its full Titan ceiling (known base), scored as one build; the place it would take on this board now.'),statTotals:t('Rated stats, all slots'),flatResistance:t('RES total'),stats:t('Stats'),stat:t('Stat'),
    compareOn:t('Enable comparison'),compareOff:t('Disable comparison'),compareWith:t('Compare with this row'),
    compareOnHint:t('Every other row shows how much more or less it gives than this one.'),
    compareReference:t('reference'),
    compareVs:t('vs'),
    compareHint:t('On the universal GRV fighter: the reference wearing this row instead of the reference row, everything else equal.'),
    compareHintPlayer:t('First-order estimate from the GRV totals on the universal fighter (a whole build cannot be swapped into it exactly).'),
    compareHintTank:t('Damage taken relative to health: includes HP and resistance. Lower is better; the ratio is the inverse of effective HP.'),
    metric:{dps:t('damage'),healer:t('ATK'),tank:t('Damage taken')},
    projected:t('At full Titan'),value:t('Value'),points:t('GRV pts'),share:t('Share'),pointsHint:t('GRV points: the item now / a perfect item of this slot'),
    statComparison:t('Item stat comparison'),grvBreakdown:t('GRV breakdown'),
  };
}

function elementIcon(element:string) {
  const option=ELEMENT_FILTER_OPTIONS.find(item=>item.id===element.toLowerCase());
  return option?.iconPath?gameAsset(option.iconPath):undefined;
}
function TrackIcon({track}:{track:ElementTrack}) {
  // Tank boards mark the element with its resistance icon, in the element colour.
  const resistance=useContext(ResistanceIconsContext)?.[track[0]!]?.icon;
  if(resistance&&track.length===1)return <img className={styles.trackIcon} data-resistance={track[0]} src={resistance} alt=""/>;
  const path=track.length===2?getDualElementIconPath(track[0],track[1]):undefined;
  const src=path?gameAsset(path):elementIcon(track[0]!);
  return src?<img className={styles.trackIcon} src={src} alt=""/>:null;
}
const trackLabel=(track:ElementTrack,locale:BuildLocale)=>track.map(element=>elementLabel(element,locale)).join(' / ');
// Filter chips only: "Physical" is shortened so the element row stays compact.
const chipLabel=(track:ElementTrack,locale:BuildLocale)=>track.map(element=>element==='Physical'?(localeText(locale)('Phys')):elementLabel(element,locale)).join(' / ');
/** Original legacy game icon for a stat added by Titan; keep its explanation accessible. */
function TitanMark({label,icon}:{label:string;icon?:string}) {
  if(!icon)return null;
  return <BuildTooltip portal className={buildStyles.itemTooltip} content={label}>
    <span className={styles.titanMark} role="img" tabIndex={0} aria-label={label}><img src={gameAsset(icon)} alt=""/></span>
  </BuildTooltip>;
}

/**
 * Region chip colours — editorial associations, not game data (blue stays for All): AP purple, NA red, EU gold (the
 * EU stars), KR white (the flag's field), SA green, SEA cyan (the tropical sea), TW pink (plum blossom).
 */


/**
 * Hover hint in the shared tooltip style of the build page instead of the browser's native `title` (2026-10-09): a
 * heading and an optional line. Without a title the trigger is returned as is.
 */

/** Every row shows its rating element, with the element name in the tooltip. */
function TrackBadge({track,locale}:{track:ElementTrack;locale:BuildLocale}) {
  const generic=useContext(GenericElementContext);
  return <Hint title={generic?(localeText(locale)('Any element', 'Любая стихия')):trackLabel(track,locale)}><span className={styles.trackBadge}><TrackIcon track={track}/></span></Hint>;
}

/** GRV points first, then the share of the ceiling, over the grade-coloured meter. */
function Score({percent,points,locale,label,gain}:{percent:number|null;points?:number|null;locale:BuildLocale;label:string;gain?:ReactNode}) {
  const {grade}=rollValueQuality(percent,100);
  const decimal=(number:number)=>formatFixed(number,locale,1);
  return <div className={`${styles.score} ${buildStyles.rollValueTheme}`} data-grade={grade}>
    <b>{points!==null&&points!==undefined&&<span className={styles.scorePoints}>{decimal(points)} <small>GRV</small></span>}<span className={styles.scorePercent}>{percent===null?'—':decimal(percent)+'%'}</span></b>
    <span className={styles.meter} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??0}><span style={{width:`${Math.max(0,Math.min(100,percent??0))}%`}}/></span>
    {gain}
  </div>;
}

/**
 * Compare (2026-10-09): each row against one reference on the universal GRV fighter -
 * a row switched on with its square button in the expanded panel, or the perfect item / player. Gear: the exact swap (gearGain); players: the
 * first-order estimate from GRV totals (buildGain). Tank improvements are negative damage taken; other roles positive output.
 */
type CompareMode='off'|'ideal'|'pin';
interface RowGain {gain:number;factors?:{id:string;gain:number}[];approximate:boolean;reference:boolean;label:string}
interface CompareApi {mode:CompareMode;pinned:string|null;pin:(id:string|null,entry?:GearTopEntry|PlayerTopEntry)=>void;
  gear:(entry:GearTopEntry,gear:GearDraft,track:ElementTrack)=>RowGain|null;player:(entry:PlayerTopEntry,value:number,maximum:number,track:ElementTrack)=>RowGain|null}
const CompareContext=createContext<CompareApi|null>(null);
/** Reference key of a row: the stored piece id / player UID, `ideal` for the perfect row (none: ATK% reference, example). */
const IDEAL_PIN='ideal';
const gearPinId=(entry:GearTopEntry)=>entry.ideal?(entry.reference?null:IDEAL_PIN):entry.gear.id??null;
const playerPinId=(entry:PlayerTopEntry)=>entry.ideal?(entry.reference?null:IDEAL_PIN):entry.player.uid??null;
const FACTOR_LABELS:Record<string,string>={attack:'ATK',attackPercent:'ATK %',damagePercent:'DMG %',crit:'Crit',hp:'HP',hpPercent:'HP %',resistance:'RES'};
/** Signed percent with two decimals: +0.18%, −0.18%, 0.00%. */
function gainText(gain:number,locale:BuildLocale) {
  const value=Math.round(gain*10000)/100;
  return `${value>0?'+':value<0?'\u2212':''}${formatFixed(Math.abs(value),locale,2)}%`;
}
const gainSign=(gain:number,role:RankingRole='dps')=>{const value=Math.round(gain*10000)*(role==='tank'?-1:1);return value>0?'up':value<0?'down':'zero';};
/** The line under a row's meter: the gain against the reference, or the reference mark. */
function GainLine({gain,locale,copy}:{gain:RowGain|null;locale:BuildLocale;copy:ReturnType<typeof useCopy>}) {
  const role=useContext(RoleContext);
  if(!gain)return null;
  if(gain.reference)return <span className={styles.gain} data-sign="reference">{copy.compareReference}</span>;
  return <Hint title={`${copy.compareVs} ${gain.label}`} text={`${gain.approximate?copy.compareHintPlayer:copy.compareHint}${role==='tank'?` ${copy.compareHintTank}`:''}`}><span className={styles.gain} data-sign={gainSign(gain.gain,role)}>
    {gain.approximate?'≈ ':''}{gainText(gain.gain,locale)} {copy.metric[role]}</span></Hint>;
}
/** Top of an expanded row: the gain against the reference, split by factor for gear. */
function CompareBar({gain,locale,copy}:{gain:RowGain|null;locale:BuildLocale;copy:ReturnType<typeof useCopy>}) {
  const role=useContext(RoleContext);
  if(!gain||gain.reference)return null;
  const parts=gain.factors?.filter(factor=>Math.round(factor.gain*10000)!==0)??[];
  return <div className={styles.compareBar}><span className={styles.compareSummary}>{copy.compareVs} {gain.label}: <b data-sign={gainSign(gain.gain,role)}>{gain.approximate?'≈ ':''}{gainText(gain.gain,locale)} {copy.metric[role]}</b>
    {parts.map(factor=><span key={factor.id} className={styles.compareFactor} data-sign={gainSign(factor.gain,role)}>{FACTOR_LABELS[factor.id]??factor.id} {gainText(factor.gain,locale)}</span>)}</span></div>;
}
/** Square button in the expand column of an expanded row: makes this row the reference, or switches comparison off. */
function CompareToggle({pinId,entry,copy,inline=false}:{pinId:string|null;entry:GearTopEntry|PlayerTopEntry;copy:ReturnType<typeof useCopy>;inline?:boolean}) {
  const compare=useContext(CompareContext);
  if(!compare||!pinId)return null;
  const active=pinId===IDEAL_PIN?compare.mode==='ideal':compare.mode==='pin'&&compare.pinned===pinId;
  const label=active?copy.compareOff:compare.mode==='off'?copy.compareOn:copy.compareWith;
  // inline: a cell of the drawer head grid (players), centred in the expand column; otherwise pinned over that column.
  return <div className={inline?styles.drawerHeadAction:styles.compareToggleSlot}><BuildTooltip portal align="end" delayMs={300} dismissOnAction className={buildStyles.itemTooltip} content={<><InspectionHeading title={label}/>{!active&&<p className={styles.sealTip}>{copy.compareOnHint}</p>}</>}>
    <button type="button" className={styles.compareToggle} aria-pressed={active} aria-label={label} onClick={()=>compare.pin(active?null:pinId,entry)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M3 5h10M3 5l-2 5a2.2 2.2 0 0 0 4 0zM13 5l-2 5a2.2 2.2 0 0 0 4 0zM5 14h6"/></svg></button></BuildTooltip></div>;
}

/**
 * Board ceiling on the right of the board head: the selected slot's maximum GRV, the range over slots when Slot is
 * All, or the sum of all twelve slot ceilings on the player board.
 */
function MaxGrv({track,slot,build,catalog,locale,copy,onHelp}:{track:ElementTrack|null;slot:string|null;build:boolean;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>;onHelp:()=>void}) {
  const role=useContext(RoleContext);
  const decimal=(number:number)=>formatFixed(number,locale,1);
  // The number needs one slot (or the whole build); under All it is the highest ceiling among the ranked tracks,
  // since every row is scored at its own best element. The help is always available.
  const ceiling=(item:ElementTrack)=>build?catalog.gear.reduce((sum,gear)=>sum+slotCeiling(gear.id,item,catalog,role),0):slot?slotCeiling(slot,item,catalog,role):null;
  const max=track?ceiling(track):build||slot?Math.max(...rankedTracks(catalog,role).map(item=>ceiling(item)??0)):null;
  return <span className={styles.maxGrv}>{max!==null&&<Hint title={copy.maxGrv} text={build?copy.maxGrvBuildHint:copy.maxGrvHint}><span>{copy.maxGrv} <b>{decimal(max)}</b> GRV</span></Hint>}
    <BuildTooltip portal align="end" delayMs={1000} dismissOnAction className={buildStyles.itemTooltip} content={copy.calculationsHelp}>
      <button type="button" className={styles.helpMark} aria-label={copy.calculationsHelp} aria-haspopup="dialog" onClick={onHelp}>?</button>
    </BuildTooltip></span>;
}

/** Board-specific reading context before the shared calculation explanations. */
function RankingScoreContext({track,locale,copy}:{track:ElementTrack|null;locale:BuildLocale;copy:ReturnType<typeof useCopy>}) {
  const role=useContext(RoleContext);
  return <div className={buildStyles.rollValueDialog} data-rv-mode="grv">
    <div className={buildStyles.rollValueIntro}><p>{role==='tank'?copy.grvSourceLeadTank:role==='healer'?copy.grvSourceLeadHealer:copy.grvSourceLead}</p></div>
    <div className={buildStyles.rollValueMethod}>
      <dl className={buildStyles.rollValueMeaning}>
        <div><dt>{copy.grvSourceScore}</dt><dd>{role==='dps'?copy.grvSourceUnit:copy.grvSourceUnitRole}</dd></div>
        <div><dt>{copy.maxGrv}</dt><dd>{role==='tank'?copy.grvSourceCeilingTank:copy.grvSourceCeiling}</dd></div>
        <div><dt>{copy.grvSourceContext}</dt><dd>{track?<>{trackLabel(track,locale)} · {role==='tank'?copy.grvSourceStatsTank:role==='healer'?copy.grvSourceStatsHealer:track.length>1?copy.grvSourcePair:copy.grvSourceStats}</>:copy.grvSourceAll}</dd></div>
        <div><dt>{copy.grvSourceTops}</dt><dd>{copy.grvSourceCurrent}</dd></div>
      </dl>
      <p className={buildStyles.rollValueNote}>{role==='tank'?copy.grvSourceAssumptionTank:copy.grvSourceAssumption}</p>
    </div>
  </div>;
}

/** Region code with the origin server's name, as its own column (server catalog from @tof-hub/contracts). */
/**
 * A nickname as the game sends it. One drawn blank (2026-10-08: twelve U+00A0, or U+2003 / U+3000 mixes) shows as a
 * visible "blank" label with its code points on hover, including runs inside a readable name.
 */
/** Nickname of a row; hovering shows the UID (and the code points of an invisible name part). */

/**
 * Combat score and update date of a player row. Hovering the CS shows the game's date of that highest CS
 * (HistoryMaxGSChangeTime, own cards only); no date, no hover title (2026-10-09).
 */
function PlayerCs({entry,locale,copy}:{entry:PlayerTopEntry;locale:BuildLocale;copy:ReturnType<typeof useCopy>}) {
  const max=entry.player.maxCombatScore,cs=max??entry.player.combatScore,at=max!=null?entry.player.maxCombatScoreAt:null;
  const updated=entry.updatedAt?formatBuildDate(entry.updatedAt,'instant',false):'';
  if(!cs)return <small>{updated||'—'}</small>;
  return <small><Hint title={at?copy.maxCsSeen:null} text={at?formatBuildDate(at,'civil'):undefined}><span>{translateUiText('CS',locale)} {formatValue(cs,false,locale)}</span></Hint>{updated&&` · ${updated}`}</small>;
}



/** Reading order of counted stats everywhere on the page: Crit, ATK, ATK %, DMG %. */
/** Flat ATK of a track is one value in game terms: universal ATK plus the element's ATK. */
function RatedChips({gear,track,catalog,locale,copy}:{gear:GearDraft;track:ElementTrack;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>}) {
  const role=useContext(RoleContext);
  return <StatChips entries={gearCurrentScore(gear,track,catalog,role).entries} track={track} catalog={catalog} locale={locale} copy={copy}/>;
}
/** The rated stats of the expanded player row, summed over every slot by stat type (2026-10-08). */
function sumRatedStats(slots:{score:{entries:{type:string;value:number}[]}}[]) {
  const totals=new Map<string,number>();
  for(const slot of slots)for(const entry of slot.score.entries)totals.set(entry.type,(totals.get(entry.type)??0)+entry.value);
  return [...totals].map(([type,value])=>({type,value}));
}
/** Rated stat chips in the game's reading order: one item's stats (gear rows) or a whole build's totals (player rows). */
function StatChips({entries,track,catalog,locale}:{entries:{type:string;value:number}[];track:ElementTrack;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>}) {
  const role=useContext(RoleContext),label=useStatLabel(locale);
  return <GearStatChips entries={entries} element={track[0]} flatElements={track} catalog={scoringCatalog(catalog)} locale={locale} role={role} label={label} equivalenceProfile={standardRVProfile(catalog.reference,track[0])} equivalenceLabel={localeText(locale)('GRV reference', 'Эталон GRV')}/>;
}

/**
 * One table per item: every stat with its value before Titan, now and at the full-Titan ceiling, side by side.
 * Pre-Titan and ceiling columns exist only when the item's pre-Titan values are known (own .tofbuild).
 */
// The GRV card compares the item now with its full-Titan ceiling; before-Titan and max-roll values stay in the Stats table.
type GearStage='now'|'maximum';
/**
 * One table per item: before Titan, now, the full-Titan ceiling of this roll split and the max-roll version, side by side.
 * Every column except "now" exists only when pre-Titan values are known (own .tofbuild); the GRV card switches stages.
 */
/** Memoised: a gear row's details are rebuilt only when the piece or board changes, not when the row opens or closes. */
const GearDetails=memo(function GearDetails(props:Parameters<typeof GearDetailsView>[0]) {return <GearDetailsView {...props}/>;});
function GearDetailsView({gear,track,catalog,locale,copy,ideal=false,reference}:{gear:GearDraft;track:ElementTrack;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>;ideal?:boolean;reference?:GearTopEntry['reference']}) {
  const role=useContext(RoleContext),label=useStatLabel(locale);
  const stages=gearStages(gear,catalog);
  const computedScores=gearStageScores(gear,track,catalog,role);
  // Generated references already contain full-Titan values, including additions whose free top slots are omitted.
  const scores=ideal?{...computedScores,maximum:computedScores.now}:computedScores;
  const [stage,setStage]=useState<GearStage>('now');
  const build=scoringCatalog(catalog);
  const rated=new Set(scores.now.entries.map(entry=>entry.type));
  const rare=catalog.reference.titanRare.items.find(item=>item.id===gear.rareId);
  const meta=catalog.gear.find(item=>item.id===gear.id);
  const hasOriginal=stages.original.some(row=>row.value!==null);
  const hasMaximum=hasOriginal&&(ideal||[...stages.maximum,...stages.maximumAugments].some(row=>row.value!==null));
  const percent=(type:string)=>!!catalog.reference.statTypes[type]?.isPercentageBased;
  const value=(type:string,number:number|null|undefined)=>number===null||number===undefined?'—':formatValue(number,percent(type),locale);
  const rows=[
    ...stages.current.map((row,index)=>({type:row.type,added:false,before:stages.original[index]?.value??null,rolls:stages.original[index]?.rolls??null,
      now:row.value,max:ideal?row.value:stages.maximum[index]?.value??null})),
    ...((gear.titan||gear.augmented)?stages.augments.map((row,index)=>({type:row.type,added:true,before:null,rolls:null,now:row.value,
      max:ideal?row.value:stages.maximumAugments[index]?.value??null})):[]),
  ].sort((a,b)=>Number(a.added)-Number(b.added)||gearStatOrder(a.type)-gearStatOrder(b.type));
  // Random stats: share of the way from the value before Titan to the ceiling. Titan-added stats start at nothing, so
  // theirs is the current value over their ceiling.
  const progress=(row:typeof rows[number])=>{
    if(row.max===null||row.max<=0)return null;
    if(row.added)return Math.max(0,Math.min(1,row.now/row.max));
    return row.before===null||row.max<=row.before?null:Math.max(0,Math.min(1,(row.now-row.before)/(row.max-row.before)));
  };
  const points=(number:number)=>formatFixed(number,locale,1);
  const tabs=([['now',copy.now],['maximum',copy.max]] as const).filter(([id])=>scores[id]);
  const shown=scores[stage]??scores.now;
  // On the Titan maximum stage: the place that score would take on this board (not for the perfect item).
  const maximumPercent=!ideal&&stage==='maximum'?scores.maximum?.percent??null:null;
  const maximumRank=useBoardRank(maximumPercent);
  const share=(rv:number)=>shown.maximum>0?rv/shown.maximum*100:0;
  const counted=[...shown.entries].sort((a,b)=>gearStatOrder(a.type)-gearStatOrder(b.type));
  // Current value / Titan maximum are adjacent; Titan progress is the last column.
  const hasGrowth=hasOriginal&&hasMaximum;
  const columns=1+Number(hasOriginal)+Number(hasGrowth)+Number(hasMaximum);
  // The perfect item leaves its other random slots to any stat (they add nothing); a tank's must not be one of the
  // Titan additions below (a stat already on top is never added). They sit with the random stats, above the Titan block.
  const added=[...new Set(rows.filter(row=>row.added).map(row=>label(row.type)))];
  const freeRows=ideal?Array.from({length:Math.max(0,catalog.reference.limits.maxNumOfRandomStats-gear.rows.filter(row=>row.type).length)},(_,index)=>
    <div key={`free-${index}`} className={styles.statLine} role="row" data-free><span role="cell" className={styles.statName}>{reference==='resistance-only'?copy.otherResistance:role==='tank'&&added.length?`${copy.anyStatExcept} ${added.join(localeText(locale)(' and ', ' и '))}`:copy.anyStat}</span></div>):null;
  return <div className={styles.details}>
    <section className={styles.detailCard} aria-label={copy.stats}>
      {/* Build card gear head: icon, name + level, Titan and stars; the rare Titan effect in the card's red on the right. */}
      <header className={styles.gearHead}><GearIcon gear={gear} catalog={catalog}/>
        <span className={styles.gearName}><span><b>{meta?.name[locale]??gear.id}</b>{!ideal&&<i>+{gear.enhancement}</i>}</span>
          <small>{gear.titan?'TITAN · ':gear.augmented?'AUGMENTED · ':''}<Stars value={gear.stars}/></small></span>
        {/* Right: the rare Titan effect and the Titan clicks (Augmentation Count). The count is known only for pieces from
            the owner's own .tofbuild; an inspected piece shows nothing instead of "—" (2026-10-08). */}
        {gear.titan&&!ideal?<span className={styles.headRight}>{rare?<span className={styles.rareEffect}>{locale === 'ru' ? rare.nameRu : translateUiText(rare.nameEn, locale)} +{gear.rareLevel}</span>:null}
          {augmentCountText(gear.augmentCount,locale)&&<small className={styles.titanClicks}>{augmentCountText(gear.augmentCount,locale)}</small>}</span>:null}</header>
      <div className={styles.detailTableViewport} role="region" aria-label={copy.statComparison} tabIndex={0}>
      <div className={styles.statTable} role="table" style={{'--columns':columns} as CSSProperties}>
        <div className={styles.statHead} role="row"><span role="columnheader">{copy.stat}</span>{hasOriginal&&<span role="columnheader"><Hint title={copy.original} text={copy.originalHint}><span>{copy.original}</span></Hint></span>}<span role="columnheader"><Hint title={copy.now} text={copy.nowHint}><span>{copy.now}</span></Hint></span>
          {hasMaximum&&<span role="columnheader"><Hint title={copy.max} text={copy.maxHint}><span>{copy.max}</span></Hint></span>}{hasGrowth&&<span role="columnheader"><Hint title={copy.growth} text={copy.titanShareHint}><span>{copy.growth}</span></Hint></span>}</div>
        {rows.map((row,index)=><Fragment key={index}>
          {row.added&&!rows[index-1]?.added&&<>{freeRows}<div className={styles.titanDivider} role="row"><span role="cell">{copy.added}</span></div></>}
          <div className={styles.statLine} role="row" data-rated={rated.has(row.type)||undefined} data-added={row.added||undefined}>
          <span role="cell" className={styles.statName}><img src={statIcon(row.type,build)} alt=""/>{label(row.type)}</span>
          {hasOriginal&&<span role="cell" className={styles.num} data-original><span>{value(row.type,row.before)}</span><small>{row.rolls!==null&&!row.added?`×${row.rolls}`:''}</small></span>}
          <span role="cell" className={styles.num} data-current><b>{value(row.type,row.now)}</b>{hasMaximum&&<span className={styles.statSlash} aria-hidden="true">/</span>}</span>
          {hasMaximum&&<span role="cell" className={styles.num}>{value(row.type,row.max)}</span>}
          {hasGrowth&&<span role="cell" className={styles.num}>{progress(row)!==null&&<Hint title={copy.growth} text={copy.titanShareHint}><span className={styles.growth} data-rated={rated.has(row.type)||undefined}>{formatValue(progress(row)!,true,locale,1)}</span></Hint>}</span>}
        </div></Fragment>)}
        {!rows.some(row=>row.added)&&freeRows}
      </div>
      </div>
    </section>
    <section className={`${styles.detailCard} ${buildStyles.rollValueTheme}`} data-grade={rollValueQuality(shown.percent,100).grade} aria-label={copy.grv}>
      <header className={styles.detailHead}><div><h3>{stage==='now'?copy.currentGrv:`GRV · ${tabs.find(([id])=>id===stage)?.[1]??''}`}</h3>{stage==='maximum'&&maximumRank!==null&&<b className={styles.maximumRank}>#{maximumRank} {copy.potentialRank}</b>}</div><span className={styles.scoreBlock}><span className={styles.bigScore}>{shown.percent===null?'—':formatValue(shown.percent/100,true,locale,1)}</span>
        <Hint title="GRV" text={copy.pointsHint}><small>{points(shown.value)} / {points(shown.maximum)} GRV</small></Hint></span></header>
      {tabs.length>1&&<div className={styles.stageTabs} role="tablist" aria-label={copy.grv}>{tabs.map(([id,label])=>{const score=scores[id]!;
        return <button key={id} type="button" role="tab" aria-selected={stage===id} onClick={()=>setStage(id)}><span>{label}</span><b>{score.percent===null?'—':formatValue(score.percent/100,true,locale,1)}</b></button>;})}</div>}
      <RollValueMeter className={styles.stack} ratio={shown.maximum>0?shown.value/shown.maximum:0} label={copy.grv} maximum={shown.maximum} segments={counted}/>
      {counted.length?<div className={styles.detailTableViewport} role="region" aria-label={copy.grvBreakdown} tabIndex={0}><ul className={styles.contrib}><li className={styles.contribHead} aria-hidden="true"><span/><span>{copy.stat}</span><span>{copy.value}</span><span>{copy.points}</span><span>{copy.share}</span></li>{counted.map(entry=><li key={entry.type}>
        <RollValueDot type={entry.type}/>
        <span className={styles.statName} data-added={entry.added||undefined}><img src={statIcon(entry.type,build)} alt=""/><span className={styles.statText}>{label(entry.type)}</span>{entry.added&&<TitanMark label={copy.titanAdded} icon={catalog.titanMark}/>}</span>
        <span className={styles.num}>{value(entry.type,entry.value)}</span>
        <span className={styles.num}><Hint title="GRV" text={copy.pointsHint}><span>{points(entry.rv)}</span></Hint></span>
        <b className={styles.num}>+{formatValue(share(entry.rv)/100,true,locale,1)}</b></li>)}</ul></div>:<p className={styles.muted}>{copy.nothingRated}</p>}
    </section>
  </div>;
}

/** Gold seal on the item icon: the values before Titan are known (the player's own .tofbuild), not just the current ones. */
/** Hover preview of an equipped item in the expanded player row: its current stats, the rated ones lit, Titan stats in red. */
/** `ratedTypes`: the stats this piece counts with inside a build (player rows: one damage element on a pair track). */
function GearStatsTip({gear,track,catalog,locale,score,ratedTypes,verified=false}:{gear:GearDraft;verified?:boolean;track:ElementTrack;catalog:RankingCatalog;locale:BuildLocale;score?:{points:number|null;percent:number|null};ratedTypes?:string[]}) {
  const role=useContext(RoleContext),label=useStatLabel(locale);
  const build=scoringCatalog(catalog);
  const rated=new Set(ratedTypes??gearStageScores(gear,track,catalog,role).now.entries.map(entry=>entry.type));
  const stages=verified?gearStages(gear,catalog):null;
  return <GearStatPreview gear={gear} catalog={build} locale={locale} ratedTypes={[...rated]} label={label} showCount={verified}
    maximums={stages?{random:stages.maximum.map(row=>row.value),added:gear.augments.map(row=>stages.maximumAugments.find(stat=>stat.type===row.type)?.value??null)}:undefined}
    score={score&&score.points!==null?<span className={`${styles.tipScore} ${buildStyles.rollValueTheme}`} data-grade={rollValueQuality(score.percent,100).grade}>{formatValue(score.points,false,locale,1)} GRV · {score.percent===null?'—':`${score.percent.toFixed(1)}%`}</span>:undefined}/>;
}
function BaseSeal({title,label}:{title:string;label:string}) {
  return <BuildTooltip portal className={buildStyles.itemTooltip} content={<><InspectionHeading title={title}/><p className={styles.sealTip}>{label}</p></>}>
    <span className={styles.baseSeal} role="img" tabIndex={0} aria-label={`${title}. ${label}`}><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.4 5.2l1.7 1.7 3.6-3.8"/></svg></span>
  </BuildTooltip>;
}
function GearIcon({gear,catalog}:{gear:GearDraft;catalog:RankingCatalog}) {
  const meta=catalog.gear.find(item=>item.id===gear.id);
  return meta?<img className={styles.gearIcon} src={meta.icons[gear.titan?'titan':gear.augmented?'augmented':'normal']} alt=""/>:null;
}

/** Reference rows need a separate expansion id per slot and variant. */
const gearRowId=(entry:GearTopEntry)=>entry.ideal?`${entry.reference??'ideal'}-${entry.gear.slot}`:`${entry.ownerPin?'me-':''}${entry.rank}`;
const playerRowId=(entry:PlayerTopEntry)=>entry.ideal?(entry.reference?`ideal-${entry.reference}`:'ideal'):`${entry.ownerPin?'me-':''}${entry.rank}`;
/** One gear row with its details; memoised so opening a row re-renders only that row. */
const GearRow=memo(function GearRow({entry,track,showTrack,genericIdeal,catalog,locale,copy,expanded,toggle}:{entry:GearTopEntry;track:ElementTrack;showTrack:boolean;genericIdeal:boolean;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>;expanded:boolean;toggle:(id:string)=>void}) {
  const role=useContext(RoleContext);
  const ownUid=useContext(OwnPlayerContext);
  // Each row is scored and drawn with its own track (its best one under All).
  const gear=entryGear(entry),meta=catalog.gear.find(item=>item.id===entry.gear.slot),rowTrack=entry.track?parseTrack(entry.track,catalog):track;
  const id=gearRowId(entry),panel=`gear-top-${id}`;
  const compare=useContext(CompareContext),gain=compare?.gear(entry,gear,rowTrack)??null;
  return <GenericElementContext.Provider key={id} value={genericIdeal&&!!entry.ideal}><Fragment>
    <div className={styles.row} role="row" data-me={!!ownUid&&entry.player.uid===ownUid&&!entry.ideal||undefined} tabIndex={ownUid&&entry.player.uid===ownUid?-1:undefined} data-expanded={expanded||undefined} data-ideal={entry.ideal||undefined} data-compare-reference={gain?.reference||undefined}>
      <span role="cell" className={styles.rank} data-podium={!entry.ideal&&entry.rank<=3?entry.rank:undefined}>{entry.rank}</span>
      <RegionCell player={entry.player}/>
      <span role="cell" className={styles.item}><span className={styles.gearIconWrap}>{!entry.ideal&&isVerifiedGear(entry.gear)?<BaseSeal title={copy.knownBaseTitle} label={copy.knownBase}/>:<span className={styles.baseSeal} aria-hidden="true"/>}<GearIcon gear={gear} catalog={catalog}/></span><span><b>{meta?.name[locale]??entry.gear.slot}</b><small>{entry.ideal?(entry.reference==='altered-resistance-percent'?copy.alteredPercentReference:entry.reference==='resistance-only'?copy.resistanceReference:entry.reference?copy.attackGearReference:copy.reference):`★${entry.gear.stars} · +${entry.gear.enhancement}`}{!entry.ideal&&isVerifiedGear(entry.gear)?` · Aug: ${augmentCountParts(entry.gear.augmentCount,locale)?.value??'—'}`:entry.gear.titan?' · TITAN':''}</small></span></span>
      <span role="cell" className={styles.playerCell}>{entry.ideal?<><b>{entry.reference==='altered-resistance-percent'?copy.alteredPercentItem:entry.reference==='resistance-only'?copy.resistanceItem:entry.reference?copy.attackItem:copy.ideal}</b><Hint title={entry.reference==='altered-resistance-percent'?copy.alteredPercentReference:entry.reference==='resistance-only'?copy.resistanceReference:entry.reference?copy.attackGearReference:copy.reference} text={entry.reference==='altered-resistance-percent'?copy.alteredPercentReference:entry.reference==='resistance-only'?copy.resistanceReference:entry.reference?copy.attackReference:copy.idealHint}><small>{entry.reference==='altered-resistance-percent'?copy.alteredPercentReference:entry.reference==='resistance-only'?copy.resistanceReference:entry.reference?copy.attackGearReference:copy.reference}</small></Hint></>:<>{entry.gear.source==='pioneer'?<span className="flex flex-wrap items-baseline gap-2">{entry.gear.ownerRegion&&<RegionCode region={entry.gear.ownerRegion}/>}<Nickname nickname={entry.gear.ownerNickname??null} copy={copy}/></span>:<Nickname nickname={entry.player.nickname} uid={entry.player.uid} copy={copy}/>}<small><time dateTime={entry.gear.lastSeenAt} title={copy.updated}>{formatBuildDate(entry.gear.lastSeenAt,'instant',false)}</time></small></>}</span>
      <span role="cell" className={`${styles.ratedCell} ${styles.hideNarrow}`}>{showTrack&&<TrackBadge track={rowTrack} locale={locale}/>}<RatedChips gear={gear} track={rowTrack} catalog={catalog} locale={locale} copy={copy}/></span>
      <span role="cell"><Score percent={entry.score} points={gearCurrentScore(gear,rowTrack,catalog,role).value} locale={locale} label={copy.grv} gain={<GainLine gain={gain} locale={locale} copy={copy}/>}/></span>
      <span role="cell"><button type="button" className={styles.expand} aria-expanded={expanded} aria-controls={panel} aria-label={expanded?copy.collapse:copy.expand} onClick={()=>toggle(id)}><svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg></button></span>
    </div>
    <Collapsible open={expanded}><div id={panel} className={styles.drawer} role="row" data-me={expanded&&!!ownUid&&entry.player.uid===ownUid&&!entry.ideal||undefined}><div role="cell" className={styles.drawerCell}><CompareToggle pinId={gearPinId(entry)} entry={entry} copy={copy}/><CompareBar gain={gain} locale={locale} copy={copy}/><GearDetails gear={gear} track={rowTrack} catalog={catalog} locale={locale} copy={copy} ideal={entry.ideal} reference={entry.reference}/></div></div></Collapsible>
  </Fragment></GenericElementContext.Provider>;
});

function GearTable({entries,track,showTrack=false,genericIdeal=false,catalog,locale,copy,open,toggle}:{entries:GearTopEntry[];track:ElementTrack;showTrack?:boolean;genericIdeal?:boolean;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>;open:ReadonlySet<string>;toggle:(id:string)=>void}) {
  return <div className={styles.table} role="table" aria-label={copy.gear}>
    <div className={`${styles.row} ${styles.head}`} role="row" data-head><span role="columnheader">{copy.rank}</span><span role="columnheader">{copy.region}</span><span role="columnheader">{copy.item}</span><span role="columnheader">{copy.player}</span><span role="columnheader" className={styles.hideNarrow}>{copy.rated}</span><span role="columnheader">{copy.grv}</span><span role="columnheader" aria-label={copy.expand}/></div>
    {entries.map(entry=>{const id=gearRowId(entry);return <GearRow key={id} entry={entry} track={track} showTrack={showTrack} genericIdeal={genericIdeal} catalog={catalog} locale={locale} copy={copy} expanded={open.has(id)} toggle={toggle}/>;})}
  </div>;
}

/**
 * Slot scores of a player row, computed once per loaded entry, role and track: typing in the search re-renders the
 * table, and a player row scores twelve items.
 */
// Keyed by what the score depends on (role, track and the stored pieces with their last observation), not by the row
// object: a search answer or a cached page brings new objects for the same players, and their scores are reused
// (2026-10-08). Rows without stored ids (perfect player, example) fall back to the object itself.
const playerScoreCache=new Map<string,{gear:ReturnType<typeof topGearDraft>[];total:ReturnType<typeof buildTrackScore>}>();
const objectScoreCache=new WeakMap<PlayerTopEntry,Map<string,{gear:ReturnType<typeof topGearDraft>[];total:ReturnType<typeof buildTrackScore>}>>();
function playerRowScore(entry:PlayerTopEntry,rowTrack:ElementTrack,catalog:RankingCatalog,role:RankingRole) {
  const track=`${role}|${rowTrack.join('-')}`;
  const stable=entry.gear.length&&entry.gear.every(item=>item.id)?track+'|'+entry.gear.map(item=>item.id+'@'+item.lastSeenAt).join(','):null;
  const cached=stable?playerScoreCache.get(stable):objectScoreCache.get(entry)?.get(track);
  if(cached){if(stable){playerScoreCache.delete(stable);playerScoreCache.set(stable,cached);}return cached;}
  // Slots in the slot filter's order (catalog order).
  const order=(id:string)=>catalog.gear.findIndex(item=>item.id===id);
  const gear=entry.gear.map(topGearDraft).sort((a,b)=>order(a.id)-order(b.id)),value={gear,total:buildTrackScore(gear,rowTrack,catalog,role)};
  if(stable){playerScoreCache.set(stable,value);while(playerScoreCache.size>600)playerScoreCache.delete(playerScoreCache.keys().next().value!);}
  else objectScoreCache.set(entry,(objectScoreCache.get(entry)??new Map()).set(track,value));
  return value;
}

/**
 * URLs of the current board (its board, role, track, slot and region): the place of a percent score (`score`) and the
 * gear-board places of stored pieces on their own slots (`pieces`, a player's build). Null outside a board.
 */
const RankUrlContext=createContext<{score:(score:number)=>string;pieces:(ids:string[])=>string}|null>(null);
/** Place a full-Titan projection would take on the current board (API /ranking/<board>/rank), or null while unknown. */
function useBoardRank(score:number|null) {
  const urls=useContext(RankUrlContext);
  const url=urls&&score!==null?urls.score(score):null;
  const [rank,setRank]=useState<{url:string;rank:number}|null>(null);
  useEffect(()=>{
    if(!url)return;
    const controller=new AbortController();
    fetch(url,{signal:controller.signal}).then(response=>response.ok?response.json() as Promise<{rank?:number}>:null)
      .then(body=>{if(body?.rank)setRank({url,rank:body.rank});}).catch(()=>{/* the place stays unknown */});
    return ()=>controller.abort();
  },[url]);
  return rank&&rank.url===url?rank.rank:null;
}

/**
 * Gear-board places of stored pieces, fetched when the details open and cached by URL.
 */
const pieceRankCache=new Map<string,{expires:number;request:Promise<Record<string,number>|null>}>();
function fetchPieceRanks(url:string) {
  let cached=pieceRankCache.get(url);
  if(!cached||cached.expires<Date.now()) {
    for(const [key,value] of pieceRankCache)if(value.expires<Date.now())pieceRankCache.delete(key);
    while(pieceRankCache.size>=100)pieceRankCache.delete(pieceRankCache.keys().next().value!);
    const request=fetch(url,{signal:AbortSignal.timeout(20_000)}).then(response=>response.ok?response.json() as Promise<{ranks?:Record<string,number>}>:null)
      .then(body=>body?.ranks??null).catch(()=>null);
    cached={expires:Date.now()+60_000,request};
    pieceRankCache.set(url,cached);
    void request.then(result=>{if(result===null&&pieceRankCache.get(url)?.request===request)pieceRankCache.delete(url);});
  }
  return cached.request;
}
/** Ids of a player row's stored pieces in slot order (none for the perfect player). */
const pieceIds=(entry:PlayerTopEntry)=>entry.ideal?[]:entry.gear.map(item=>item.id).filter((id):id is string=>!!id);
/** Gear-board places of a build's stored pieces on their own slots (API /ranking/gear/ranks), by piece id; undefined while loading. */
function usePieceRanks(ids:string[],open:boolean) {
  const urls=useContext(RankUrlContext);
  const url=urls&&ids.length?urls.pieces(ids):null;
  const [ranks,setRanks]=useState<{url:string;ranks:Record<string,number>|null}|null>(null);
  useEffect(()=>{
    if(!url||!open)return;
    let live=true,timer:ReturnType<typeof setTimeout>|undefined;
    const load=async(attempt:number)=>{
      const result=await fetchPieceRanks(url);
      if(!live)return;
      setRanks({url,ranks:result});
      if(result===null&&attempt<4)timer=setTimeout(()=>void load(attempt+1),1000*2**attempt);
    };
    void load(0);
    return ()=>{live=false;clearTimeout(timer);};
  },[url,open]);
  return ranks&&ranks.url===url?ranks.ranks:undefined;
}

/** The potential is projected once the open animation has played (about its length). */
const POTENTIAL_DELAY_MS=320;
/** Full-Titan potential of a build whose every piece has a known base, with the place it would take on this board. */
function BuildPotential({gear,track,catalog,locale,copy}:{gear:GearDraft[];track:ElementTrack;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>}) {
  const role=useContext(RoleContext);
  // Computed after the details have opened (it projects all twelve pieces to full Titan), so the row opens at once.
  // Until then its space stays reserved: on narrow boards it is a row of its own, which would add a line after the opening.
  const [potential,setPotential]=useState<ReturnType<typeof buildTitanMaximum>|undefined>(undefined);
  useEffect(()=>{const timer=setTimeout(()=>setPotential(buildTitanMaximum(gear,track,catalog,role)),POTENTIAL_DELAY_MS);return ()=>clearTimeout(timer);},[gear,track,catalog,role]);
  const rank=useBoardRank(potential?.percent??null);
  if(potential===null)return null;
  if(!potential)return <div className={styles.potentialSlot} style={{visibility:'hidden'}} aria-hidden="true"><div className={styles.potential}>
    <div className={styles.potentialHead}><span>{copy.potential}</span></div>
    <Score percent={0} points={0} locale={locale} label={copy.potential}/>
  </div></div>;
  return <div className={styles.potentialSlot}><Hint title={copy.potential} text={copy.potentialHint}><div className={styles.potential}>
    <div className={styles.potentialHead}><span>{copy.potential}</span>{rank!==null&&<b>#{rank} {copy.potentialRank}</b>}</div>
    <Score percent={potential.percent} points={potential.value} locale={locale} label={copy.potential}/>
  </div></Hint></div>;
}

/**
 * The expanded player's twelve slot cards. Each stored piece also shows its place on the gear board of its own slot
 * with the board's track, role and region (one /ranking/gear/ranks request per open row, 2026-10-08).
 */
function PlayerSlotGrid({entry,slots,track,catalog,locale,copy,open}:{entry:PlayerTopEntry;slots:ReturnType<typeof playerRowScore>['total']['slots'];track:ElementTrack;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>;open:boolean}) {
  const pieceId=(slot:string)=>entry.gear.find(item=>item.slot===slot)?.id;
  const ranks=usePieceRanks(entry.synthetic?[]:pieceIds(entry),open);
  return <div className={styles.slotGrid}>{slots.map(slot=>{
    const meta=catalog.gear.find(item=>item.id===slot.gear.id),id=pieceId(slot.gear.id),rank=id?ranks?.[id]:undefined,loading=!!id&&ranks===undefined;
    const ownerPiece=entry.synthetic?entry.gear.find(item=>item.slot===slot.gear.id):null;
    const ownerNickname=ownerPiece?.ownerNickname,ownerRegion=ownerPiece?.ownerRegion,ownerServerId=ownerPiece?.ownerServerId;
    const ownerServer=ownerServerId?getServerById(ownerServerId):null;
    return <BuildTooltip key={slot.gear.id} portal className={buildStyles.itemTooltip} content={<>{ownerNickname&&<p className={styles.slotOwnerTip}>{ownerRegion&&<RegionCode region={ownerRegion}/>}<Nickname nickname={ownerNickname} copy={copy}/>{ownerServerId&&<small title={`ID: ${ownerServerId}`}>{ownerServer?.name??ownerServerId}</small>}</p>}<GearStatsTip gear={slot.gear} verified={!entry.ideal&&entry.gear.some(item=>item.slot===slot.gear.id&&isVerifiedGear(item))} track={track} catalog={catalog} locale={locale} ratedTypes={slot.score.entries.map(item=>item.type)}/></>}>
      <div className={styles.slotCard} tabIndex={0}><GearIcon gear={slot.gear} catalog={catalog}/><span><b>{translateUiText(meta?.name[locale]??slot.gear.id,locale)}</b>{/* A stored piece reads grey "Top" and its gold "#N" ("…" while it loads; stars and level stay in the hover card).
            Stars and level only for pieces without a place (the perfect player). */}
        {entry.synthetic?<small><Nickname nickname={ownerNickname??null} copy={copy}/></small>:id?<small title={copy.slotRankHint}>{copy.slotRankWord} <em className={styles.slotRank}>{rank!==undefined?`#${rank}`:loading?'…':'—'}</em></small>:<small>★{slot.gear.stars}{entry.ideal?'':` · +${slot.gear.enhancement}`}</small>}</span><Score percent={slot.percent} points={slot.score.value} locale={locale} label={copy.grv}/></div></BuildTooltip>;
  })}</div>;
}

/** One player row with its details; memoised so opening a row re-renders only that row. */
/**
 * An expanded player's details, memoised on its (cached) row score so opening or closing the row only replays the
 * animation instead of rebuilding the details (2026-10-08).
 */
const PlayerDetails=memo(function PlayerDetails({entry,gear,slots,track,catalog,locale,copy,open}:{entry:PlayerTopEntry;gear:GearDraft[];slots:ReturnType<typeof playerRowScore>['total']['slots'];track:ElementTrack;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>;open:boolean}) {
  const rowTrack=track;
  return <>
      {/* Drawer head on the row's own grid: first the Titan potential (a fully known build only, same condition as the base
          seal) with its caption left of the bar and the bar in the GRV column, then the stat totals across the row. */}
      <div className={`${styles.playerRow} ${styles.drawerHead}`}>
        {!entry.ideal&&hasKnownBuildBase(entry.gear)&&<BuildPotential gear={gear} track={rowTrack} catalog={catalog} locale={locale} copy={copy}/>}
        <CompareToggle pinId={playerPinId(entry)} entry={entry} copy={copy} inline/>
        <div className={styles.statTotals}><span>{copy.statTotals}</span><StatChips entries={sumRatedStats(slots)} track={rowTrack} catalog={catalog} locale={locale} copy={copy}/></div>
      </div>
      <PlayerSlotGrid entry={entry} slots={slots} track={rowTrack} catalog={catalog} locale={locale} copy={copy} open={open}/>
  </>;
});

const PlayerRow=memo(function PlayerRow({entry,track,showTrack,genericIdeal,catalog,locale,copy,expanded,toggle}:{entry:PlayerTopEntry;track:ElementTrack;showTrack:boolean;genericIdeal:boolean;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>;expanded:boolean;toggle:(id:string)=>void}) {
  const role=useContext(RoleContext);
  const ownUid=useContext(OwnPlayerContext);
  const scoringTrack=entry.track?parseTrack(entry.track,catalog):track;
  const {gear,total}=playerRowScore(entry,scoringTrack,catalog,role),slots=total.slots,id=playerRowId(entry),panel=`player-top-${id}`;
  const source=total.choice?.Attack;
  const rowTrack=source&&scoringTrack.length===2?[source,...scoringTrack.filter(element=>element!==source)]:scoringTrack;
  const compare=useContext(CompareContext),gain=compare?.player(entry,total.value,total.maximum,rowTrack)??null;
  return <GenericElementContext.Provider key={id} value={genericIdeal&&!!entry.ideal}><Fragment>
    <div className={`${styles.row} ${styles.playerRow}`} role="row" data-me={!!ownUid&&entry.player.uid===ownUid&&!entry.ideal||undefined} tabIndex={ownUid&&entry.player.uid===ownUid?-1:undefined} data-expanded={expanded||undefined} data-ideal={entry.ideal||undefined} data-compare-reference={gain?.reference||undefined}>
      <span role="cell" className={styles.rank} data-podium={!entry.ideal&&entry.rank<=3?entry.rank:undefined}>{entry.rank}</span>
      <RegionCell player={entry.player}/>
      <span role="cell" className={styles.playerCell}>{entry.synthetic?<><Nickname nickname={entry.player.nickname} copy={copy}/><small>{localeText(locale)('Synthetic build', 'Синтетический комплект')}</small></>:entry.ideal?<><b>{entry.reference==='resistance-only'?copy.resistancePlayer:entry.reference==='attack-percent'?copy.attackPlayer:copy.idealPlayer}</b><small>{entry.reference==='resistance-only'?copy.resistanceReference:entry.reference==='attack-percent'?copy.attackReference:copy.reference}</small></>:<><Nickname nickname={entry.player.nickname} uid={entry.player.uid} copy={copy}/><PlayerCs entry={entry} locale={locale} copy={copy}/></>}</span>
      <span role="cell" className={`${styles.slotStrip} ${styles.hideNarrow}`}>{/* Every piece from the player's own .tofbuild (known base): the same seal as a gear row (2026-10-08). */}
        {!entry.ideal&&isVerifiedPlayer(entry)&&<span className={styles.sealSlot}><BaseSeal title={copy.knownBaseBuildTitle} label={copy.knownBaseBuild}/></span>}{showTrack&&<TrackBadge track={rowTrack} locale={locale}/>}{slots.map(slot=><BuildTooltip key={slot.gear.id} portal className={buildStyles.itemTooltip} content={<GearStatsTip gear={slot.gear} verified={!entry.ideal&&entry.gear.some(item=>item.slot===slot.gear.id&&isVerifiedGear(item))} track={rowTrack} catalog={catalog} locale={locale} score={{points:slot.score.value,percent:slot.percent}} ratedTypes={slot.score.entries.map(item=>item.type)}/>}>
        <span className={`${styles.slotChip} ${buildStyles.rollValueTheme}`} tabIndex={0} data-grade={rollValueQuality(slot.percent,100).grade}><GearIcon gear={slot.gear} catalog={catalog}/></span></BuildTooltip>)}</span>
      <span role="cell"><Score percent={entry.score} points={total.value} locale={locale} label={copy.total} gain={<GainLine gain={gain} locale={locale} copy={copy}/>}/></span>
      <span role="cell"><button type="button" className={styles.expand} aria-expanded={expanded} aria-controls={panel} aria-label={expanded?copy.collapse:copy.expand} onClick={()=>toggle(id)}><svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg></button></span>
    </div>
    <Collapsible open={expanded}><div id={panel} className={styles.drawer} role="row" data-me={expanded&&!!ownUid&&entry.player.uid===ownUid&&!entry.ideal||undefined}><div role="cell" className={styles.drawerCell}>
      <PlayerDetails entry={entry} gear={gear} slots={slots} track={rowTrack} catalog={catalog} locale={locale} copy={copy} open={expanded}/></div></div></Collapsible>
  </Fragment></GenericElementContext.Provider>;
});

function PlayerTable({entries,track,showTrack=false,genericIdeal=false,catalog,locale,copy,open,toggle}:{entries:PlayerTopEntry[];track:ElementTrack;showTrack?:boolean;genericIdeal?:boolean;catalog:RankingCatalog;locale:BuildLocale;copy:ReturnType<typeof useCopy>;open:ReadonlySet<string>;toggle:(id:string)=>void}) {
  return <div className={styles.table} role="table" aria-label={copy.players}>
    <div className={`${styles.row} ${styles.playerRow} ${styles.head}`} role="row" data-head><span role="columnheader">{copy.rank}</span><span role="columnheader">{copy.region}</span><span role="columnheader">{copy.player}</span><span role="columnheader" className={styles.hideNarrow}>{copy.slots}</span><span role="columnheader">{copy.total}</span><span role="columnheader" aria-label={copy.expand}/></div>
    {entries.map(entry=>{const id=playerRowId(entry);return <PlayerRow key={id} entry={entry} track={track} showTrack={showTrack} genericIdeal={genericIdeal} catalog={catalog} locale={locale} copy={copy} expanded={open.has(id)} toggle={toggle}/>;})}
  </div>;
}

/**
 * Board responses by request key for a minute (2026-10-08): clearing a search or switching back to a filter shows the
 * same rows at once, with the same entry objects, so memoised rows are not rebuilt and nothing is fetched again.
 */
const responseCache=new RankingResponseCache();
const cachedResponse=(key:string)=>responseCache.get(key);
const storeResponse=(key:string,response:RankingResponse<GearTopEntry|PlayerTopEntry>)=>responseCache.set(key,response);
/** Lower-cased and normalised search text of a player (nickname, UID, region, server), built once per player object. */
const searchTexts=new WeakMap<object,{plain:string;normal:string}>();
function playerSearchText(player:GearTopEntry['player'],extra:string) {
  let text=searchTexts.get(player);
  if(!text) {
    const parts=[player.nickname,player.uid,player.region,player.serverId,player.serverId?getServerById(player.serverId)?.name:null].filter((part):part is string=>!!part);
    text={plain:parts.join('\n').toLowerCase(),normal:parts.map(part=>normalizeSearchText(part)).join('\n')};
    searchTexts.set(player,text);
  }
  return extra?{plain:text.plain+'\n'+extra.toLowerCase(),normal:text.normal+'\n'+normalizeSearchText(extra)}:text;
}

/**
 * Rows shown of a list: a new list (other first rows) starts with ROW_BATCH rows and grows by ROW_BATCH per frame, so a
 * hundred fresh rows never land in one long commit; rows appended by the endless board stay as they are (2026-10-08).
 */
const ROW_BATCH=25;
function useProgressiveCount(length:number,signature:string) {
  const [state,setState]=useState({signature,count:Math.min(length,ROW_BATCH)});
  const count=state.signature===signature?Math.min(length,Math.max(state.count,ROW_BATCH)):Math.min(length,ROW_BATCH);
  useEffect(()=>{
    if(state.signature!==signature){setState({signature,count:Math.min(length,ROW_BATCH)});return;}
    if(count>=length)return;
    const frame=requestAnimationFrame(()=>setState(current=>({signature,count:Math.min(length,current.count+ROW_BATCH)})));
    return ()=>cancelAnimationFrame(frame);
  },[signature,count,length,state.signature]);
  return count;
}

/** `initialSearch`: the `q` of a shared link, put back into the search box. */
/** `vs` in the address bar: `ideal`, or the reference piece id / player UID. */
function parseCompare(value:string|undefined):{mode:CompareMode;pin:string|null} {
  if(value===IDEAL_PIN)return {mode:'ideal',pin:null};
  return value?{mode:'pin',pin:value.slice(0,64)}:{mode:'off',pin:null};
}
export function RankingView({catalog,initial,initialSearch='',initialCompare}:{catalog:RankingCatalog;initial:RankingQueryState;initialSearch?:string;initialCompare?:string}) {
  const animationRoot=useRef<HTMLDivElement>(null);
  const {locale}=useLocale();
  const copy=useCopy(locale);
  const {notify}=useToast();
  const [query,setQuery]=useState(initial);
  const [frameAnimations,setFrameAnimations]=useState<{ready:boolean;enabled:boolean}>({ready:false,enabled:true});
  useEffect(()=>{
    let enabled=true;
    try {enabled=window.localStorage.getItem(FRAME_ANIMATION_STORAGE_KEY)!=='off';} catch { /* Browser storage can be disabled. */ }
    setFrameAnimations({ready:true,enabled});
  },[]);
  const toggleFrameAnimations=()=>{
    const enabled=!frameAnimations.enabled;
    setFrameAnimations({ready:true,enabled});
    try {window.localStorage.setItem(FRAME_ANIMATION_STORAGE_KEY,enabled?'on':'off');} catch { /* Keep the choice for this page session. */ }
  };
  // Several rows can stay expanded; a new board (filters, upload, example) starts collapsed.
  const [open,setOpenRows]=useState<ReadonlySet<string>>(()=>new Set());
  const collapseAll=()=>setOpenRows(new Set());
  const toggleOpen=useCallback((id:string)=>setOpenRows(current=>{const next=new Set(current);if(!next.delete(id))next.add(id);return next;}),[]);
  const [example,setExample]=useState(false);
  const [version,setVersion]=useState(0);
  const [ideal,setIdeal]=useState(false);
  const [compare,setCompare]=useState(()=>parseCompare(initialCompare));
  // The pinned row as it was pinned, so it stays the reference after a search hides it.
  const [pinnedEntry,setPinnedEntry]=useState<GearTopEntry|PlayerTopEntry|null>(null);
  const [search,setSearch]=useState(initialSearch);
  const [uploadNote,setUploadNote]=useState('');
  const [uploadTone,setUploadTone]=useState<'info'|'error'>('info');
  const [uploading,setUploading]=useState(false);
  /** The upload waiting in the shared queue (docs/architecture/job-queue.md). */
  const [queueJob,setQueueJob]=useState<QueueJob|null>(null);
  // Right rail (as on Build and Wish): players upload, the capture app, how GRV/PRV are calculated.
  const [railDialog,setRailDialog]=useState<'app'|'update'|'formulas'|null>(null);
  const [captureKind,setCaptureKind]=useState<'players'|'build'>('players');
  const playersInput=useRef<HTMLInputElement>(null);
  const buildInput=useRef<HTMLInputElement>(null);
  // Under All the weights dialog opens on the first non-Altered element of the catalog (its own picker switches).
  const defaultElement=Object.keys(catalog.elementIcons).find(element=>element!=='Altered')??'';
  const [result,setResult]=useState<{key:string;board:string;q:string;response:RankingResponse<GearTopEntry|PlayerTopEntry>|null;error:boolean}|null>(null);
  const [rankingAttempt,setRankingAttempt]=useState(0);
  // Search: the loaded board is narrowed at once; after a pause the server searches the whole board (players outside
  // the loaded top, former nicknames) and returns real ranks.
  // The box updates at once; narrowing and the table follow a deferred copy, so typing never waits for the rows.
  const deferredSearch=useDeferredValue(search);
  const needle=deferredSearch.trim().toLowerCase(),searchNeedle=normalizeSearchText(deferredSearch);
  // The search in the address bar (`q`, 2026-10-08): the typed text once typing pauses; none while the box is empty.
  const [urlSearch,setUrlSearch]=useState(initialSearch.trim().slice(0,SEARCH_MAX));
  useEffect(()=>{
    const value=search.trim().slice(0,SEARCH_MAX);
    if(!value){setUrlSearch('');return;}
    const timer=setTimeout(()=>setUrlSearch(value),SEARCH_DELAY);
    return ()=>clearTimeout(timer);
  },[search]);
  const remoteSearch=urlSearch.length>=SEARCH_MIN?urlSearch:'';
  // All: each item / player at its best track (including Altered); `track` stays the fallback for per-element widgets.
  const allTracks=query.track===ALL_TRACKS;
  const parsed=useMemo(()=>parseTrack(query.track,catalog),[query.track,catalog]);
  // A tank has no pair tracks (resistance is not inherited): a pair falls back to its first element.
  const track=useMemo(()=>query.role==='tank'&&parsed.length>1?[parsed[0]!]:parsed,[query.role,parsed]);
  const trackParam=allTracks?ALL_TRACKS:trackId(track);
  // Gear board: slots whose item name matches the search are found by the server too.
  const slotsParam=useMemo(()=>{
    const name=normalizeSearchText(remoteSearch);
    return name&&query.board==='gear'?catalog.gear.filter(item=>normalizeSearchText(localizedUi(item.name, locale)).includes(name)).map(item=>item.id).join(','):'';
  },[remoteSearch,query.board,catalog,locale]);
  const board=JSON.stringify({...query,track:trackParam,version});
  const key=JSON.stringify({board,q:remoteSearch,slots:slotsParam});

  // The address bar mirrors the filters so a top can be shared; no navigation happens.
  useEffect(()=>{
    const params=new URLSearchParams();
    if(query.board!=='players')params.set('board',query.board);
    if(query.role!=='dps')params.set('role',query.role);
    if(trackParam!==ALL_TRACKS)params.set('track',trackParam);
    if(query.slot&&query.board==='gear')params.set('slot',query.slot);
    if(query.region)params.set('region',query.region);
    if(query.dataset)params.set('dataset',query.dataset);
    if(query.verified)params.set('verified','1');
    if(query.places==='global')params.set('places','global');
    if(query.sort&&query.sort!=='grv'&&(!query.sort.startsWith('cs')||query.board==='players')&&(!query.sort.startsWith('aug')||query.board==='gear'))params.set('sort',query.sort);
    if(urlSearch)params.set('q',urlSearch);
    if(compare.mode==='ideal')params.set('vs',IDEAL_PIN);
    else if(compare.mode==='pin'&&compare.pin)params.set('vs',compare.pin);
    window.history.replaceState(null,'',`${window.location.pathname}${params.size?`?${params}`:''}`);
  },[query,trackParam,urlSearch,compare]);

  /** One page of the current board (LIMIT rows from `offset`). */
  // The place a projected score would take on the current board (its slot and region filters included), and the
  // gear-board places of a player's pieces on their own slots (same track, role and region).
  // Memoised so opening a row does not update the other consumers of this context.
  const rankUrls=useMemo(()=>({
    score:(score:number)=>{
      const params=new URLSearchParams({track:trackParam,role:query.role,score:score.toFixed(4)});
      if(query.dataset)params.set('dataset',query.dataset);
      if(query.slot&&query.board==='gear')params.set('slot',query.slot);
      if(query.region)params.set('region',query.region);
      if(query.places==='global')params.set('places','global');
      return `/api/v1/ranking/${query.board}/rank?${params}`;
    },
    pieces:(ids:string[])=>{
      const params=new URLSearchParams({track:trackParam,role:query.role,ids:ids.join(',')});
      if(query.dataset)params.set('dataset',query.dataset);
      if(query.region)params.set('region',query.region);
      if(query.places==='global')params.set('places','global');
      return `/api/v1/ranking/gear/ranks?${params}`;
    },
  }),[trackParam,query.role,query.region,query.slot,query.board,query.places,query.dataset]);
  const pageUrl=(offset:number)=>{
    const params=new URLSearchParams({track:trackParam,role:query.role,limit:String(LIMIT)});
    if(query.dataset)params.set('dataset',query.dataset);
    if(offset)params.set('offset',String(offset));
    if(query.slot&&query.board==='gear')params.set('slot',query.slot);
    if(query.region)params.set('region',query.region);
    if(query.verified)params.set('verified','1');
    if(query.places==='global')params.set('places','global');
    if(query.sort&&query.sort!=='grv'&&(!query.sort.startsWith('cs')||query.board==='players')&&(!query.sort.startsWith('aug')||query.board==='gear'))params.set('sort',query.sort);
    if(remoteSearch)params.set('q',remoteSearch);
    if(slotsParam)params.set('slots',slotsParam);
    return `/api/v1/ranking/${query.board}?${params}`;
  };
  useEffect(()=>{
    const cached=cachedResponse(key);
    if(cached){setResult({key,board,q:remoteSearch,response:cached,error:false});return;}
    const controller=new AbortController();
    // A replaced effect (including Strict Mode's mount check) must not start another HTTP request.
    void Promise.resolve().then(()=>controller.signal.aborted?null:fetch(pageUrl(0),{signal:controller.signal,cache:'no-store'}))
      .then(response=>{if(!response)return null;if(!response.ok)throw new Error(`Ranking API returned ${response.status}`);return response.json() as Promise<RankingResponse<GearTopEntry|PlayerTopEntry>>;})
      .then(response=>{if(!response||controller.signal.aborted)return;storeResponse(key,response);setResult({key,board,q:remoteSearch,response,error:false});})
      // A failed API request is not an empty database and must not enter the response cache.
      .catch(()=>{if(!controller.signal.aborted)setResult({key,board,q:remoteSearch,response:null,error:true});});
    return ()=>controller.abort();
    // pageUrl reads exactly these values.
  },[key,board,query.board,query.role,query.region,query.slot,trackParam,remoteSearch,slotsParam,rankingAttempt]);

  // Endless board (2026-10-08): the next LIMIT rows load quietly once the row LOAD_AHEAD from the end shows up. A row is
  // watched rather than a margin below the list: a rootMargin does not reach past a scrolling ancestor of the page.
  const [moreState,setMoreState]=useState<{key:string;status:'loading'|'error'|'idle'}|null>(null);
  const [moreAttempt,setMoreAttempt]=useState(0);
  const loadingMore=moreState?.key===key&&moreState.status==='loading';
  const moreError=moreState?.key===key&&moreState.status==='error';
  const moreRef=useRef<HTMLDivElement>(null);
  const loadedCount=result?.key===key?result.response?.entries.length??0:0,boardTotal=result?.key===key?result.response?.total??loadedCount:0;
  const boardOverall=result?.key===key?result.response?.overall??boardTotal:0;
  const canLoadMore=loadedCount>0&&loadedCount<boardTotal;


  // While a search runs on the server, the same board stays on screen, narrowed locally.
  const pending=result?.key!==key,searching=pending&&result?.board===board;
  const loading=pending&&!searching;
  const live=loading?EMPTY_ENTRIES:result?.response?.entries??EMPTY_ENTRIES;
  // Rows the server already searched are not narrowed again (they may match a former nickname).
  const serverSearched=!pending&&!!result?.q&&normalizeSearchText(result.q)===searchNeedle;
  const databaseEmpty=!pending&&result?.response?.available===true&&result.response.databaseEmpty===true;
  const showExample=example&&databaseEmpty&&!live.length;
  const gearEntries=useMemo(()=>query.board==='gear'?(showExample?exampleGearTop(catalog,allTracks?null:track,query.slot,query.role):live as GearTopEntry[]):[],[query.board,showExample,catalog,allTracks,track,query.slot,query.role,live]);
  const playerEntries=useMemo(()=>query.board==='players'?(showExample?examplePlayerTop(catalog,allTracks?null:track,query.role):live as PlayerTopEntry[]):[],[query.board,showExample,catalog,allTracks,track,query.role,live]);
  const me=useRankingOwner(board,pageUrl(0),live);
  // The role switch sits in the search bar on wide screens and on its own row on phones (one of the two is hidden).
  const roleSwitch=<ModeSwitcher className={styles.roleSwitch} value={query.role} onChange={role=>update({role})} ariaLabel={copy.role} dataAttribute="data-role"
          options={RANKING_ROLE_OPTIONS.map(({value,variant})=>{const option=ROLE_FILTER_OPTIONS.find(item=>item.id===variant);
            return {value,label:copy[value],tone:variant,icon:option?.iconPath?gameAsset(option.iconPath):undefined};})}/>;
  const update=(next:Partial<RankingQueryState>)=>{collapseAll();setQuery(current=>({...current,...next}));
    // A pinned piece or player belongs to its board; another board compares with its own best.
    const datasetChanged='dataset' in next&&next.dataset!==query.dataset;
    if(datasetChanged)setExample(false);
    if(datasetChanged||(next.board&&next.board!==query.board&&compare.mode==='pin')) {
      setCompare({mode:'off',pin:null});setPinnedEntry(null);
    }};
  // Local narrowing of the loaded board: nickname, UID, region, server and (gear) item name.
  const matches=useCallback((player:GearTopEntry['player'],extra='')=>{
    if(!needle||serverSearched)return true;
    const text=playerSearchText(player,extra);
    return text.plain.includes(needle)||(!!searchNeedle&&text.normal.includes(searchNeedle));
  },[needle,serverSearched,searchNeedle]);
  const itemNames=useMemo(()=>new Map(catalog.gear.map(item=>[item.id,item.name[locale]])),[catalog,locale]);
  const gearMatched=useMemo(()=>gearEntries.filter(entry=>(!query.verified||isVerifiedGear(entry.gear))&&matches(entry.player,itemNames.get(entry.gear.slot)??'')),[gearEntries,query.verified,matches,itemNames]);
  const playersMatched=useMemo(()=>playerEntries.filter(entry=>(!query.verified||isVerifiedPlayer(entry))&&matches(entry.player)),[playerEntries,query.verified,matches]);
  // Perfect item / player: rank 0 reference rows on top of the board, outside search and counts.
  // Under All one reference serves every element (equal ceilings): the Physical track, labelled "Elemental".
  const idealTrack=useMemo(()=>allTracks?rankedTracks(catalog,query.role).find(item=>item.length===1&&item[0]==='Physical')??rankedTracks(catalog,query.role)[0]!:track,[allTracks,catalog,query.role,track]);
  const references=useMemo(()=>{
    if(!ideal)return {gear:[],players:[]};
    const tag=<T extends object>(entry:T)=>allTracks?{...entry,track:trackId(idealTrack)}:entry;
    return query.board==='gear'
      ?{gear:[...idealGearTop(catalog,idealTrack,query.slot,query.role).map(tag),...(query.role==='tank'?resistanceGearTop(catalog,idealTrack,query.slot).map(tag):attackGearTop(catalog,idealTrack,query.slot,query.role).map(tag))],players:[]}
      :{gear:[],players:[tag(idealPlayerTop(catalog,idealTrack,query.role)),...(query.role==='tank'?[tag(resistancePlayerTop(catalog,idealTrack))]:[tag(attackPlayerTop(catalog,idealTrack,query.role))])]};
  },[ideal,allTracks,idealTrack,query.board,query.slot,query.role,catalog]);
  const gearWithOwner=useMemo(()=>query.board==='gear'?includeOwnerEntries(gearMatched,me.entries as GearTopEntry[],gearRowId,me.pinned):gearMatched,[gearMatched,me.entries,me.pinned,query.board]);
  const playersWithOwner=useMemo(()=>query.board==='players'?includeOwnerEntries(playersMatched,me.entries as PlayerTopEntry[],entry=>entry.player.uid??String(entry.rank),me.pinned):playersMatched,[playersMatched,me.entries,me.pinned,query.board]);
  const gearShown=useMemo(()=>references.gear.length?[...references.gear,...gearWithOwner]:gearWithOwner,[references,gearWithOwner]);
  const playersShown=useMemo(()=>references.players.length?[...references.players,...playersWithOwner]:playersWithOwner,[references,playersWithOwner]);
  // Counter (2026-10-08): the first number is what the filters match on the whole board (server count, not the rows
  // loaded so far), the second every stored player / piece. While a search is still narrowed only locally, the first
  // number is the matching loaded rows.
  // The tables take deferred lists: React builds new rows in the background while the input and controls stay live.
  const deferredGear=useDeferredValue(gearShown),deferredPlayers=useDeferredValue(playersShown);
  const deferredList:{player:{uid?:string|null}}[]=query.board==='gear'?deferredGear:deferredPlayers;
  // A list counts as new when its first rows differ (search, filters); appended pages keep the rows already shown.
  const listSignature=query.board+'|'+deferredList.slice(0,3).map((entry,index)=>entry.player.uid??index).join(',');
  const shownRows=useProgressiveCount(deferredList.length,listSignature);
  useVisibleTitanFrames(animationRoot,`${key}|${listSignature}|${shownRows}|${locale}`,frameAnimations.ready&&frameAnimations.enabled);
  const [revealAttempt,setRevealAttempt]=useState(0);
  const focusedOwner=useRef('');
  const cancelOwnerScroll=useRef<(()=>void)|null>(null);
  useEffect(()=>()=>{cancelOwnerScroll.current?.();cancelOwnerScroll.current=null;},[board,me.active,me.owner?.uid,revealAttempt]);
  useEffect(()=>{
    if(!me.active||me.status!=='ready'||!me.owner)return;
    const token=board+'|'+me.owner.uid+'|'+revealAttempt;
    if(focusedOwner.current===token)return;
    const row=animationRoot.current?.querySelector<HTMLElement>('[data-me]');
    if(!row)return;
    focusedOwner.current=token;
    row.focus({preventScroll:true});
    cancelOwnerScroll.current?.();
    cancelOwnerScroll.current=scrollToSection(row,{durationMs:420,onlyIfOutside:true,block:'center'});
  },[me.active,me.status,me.owner,board,revealAttempt,shownRows,deferredGear,deferredPlayers]);
  useEffect(()=>{
    if(me.status==='missing')notify(copy.t('Your profile has no entries under these ranking filters.','У вашего профиля нет строк с текущими фильтрами рейтинга.'));
    if(me.status==='error')notify(copy.t('Could not find your place. Try Me again.','Не удалось найти ваше место. Выключите и снова включите «Я».'),{tone:'error'});
  },[me.status,locale,notify]);
  useEffect(()=>{
    const sentinel=moreRef.current;
    if(!sentinel||!canLoadMore||shownRows<loadedCount||typeof IntersectionObserver==='undefined')return;
    const controller=new AbortController();
    let requested=false;
    const rows=sentinel.parentElement?.querySelectorAll('[role="table"]>[role="row"]:not([data-head])');
    const target=rows&&rows.length>LOAD_AHEAD?rows[rows.length-LOAD_AHEAD]!:sentinel;
    const observer=new IntersectionObserver(entries=>{
      if(requested||!entries.some(entry=>entry.isIntersecting))return;
      requested=true;observer.disconnect();setMoreState({key,status:'loading'});
      const forKey=key;
      fetch(pageUrl(loadedCount),{cache:'no-store',signal:controller.signal})
        .then(response=>{if(!response.ok)throw new Error('Ranking page failed');return response.json() as Promise<RankingResponse<GearTopEntry|PlayerTopEntry>>;})
        .then(page=>{
          if(controller.signal.aborted)return;
          if(!page.available||!page.entries.length)throw new Error('Ranking page unavailable');
          setResult(current=>{
          if(!current||current.key!==forKey||!current.response)return current;
          const response={...current.response,entries:[...current.response.entries,...page.entries]};
          storeResponse(forKey,response);
          return {...current,response};
          });
          setMoreState({key:forKey,status:'idle'});
        })
        .catch(()=>{if(!controller.signal.aborted)setMoreState({key:forKey,status:'error'});});
    },{rootMargin:'200px 0px'});
    observer.observe(target);
    if(target!==sentinel)observer.observe(sentinel);
    return ()=>{observer.disconnect();controller.abort();};
    // pageUrl reads the board values that make up `key`.
  },[canLoadMore,key,loadedCount,moreAttempt,shownRows]);
  const loadedMatched=query.board==='gear'?gearMatched.length:playersMatched.length;
  const shownCount=showExample||(needle&&!serverSearched)?loadedMatched:Math.max(boardTotal,loadedMatched);
  const totalCount=showExample?(query.board==='gear'?gearEntries.length:playerEntries.length):Math.max(boardOverall,shownCount);
  // Every generated mono element, including Altered, has a role-specific board.
  // Same order as the Info · Simulacra element filter (ELEMENT_FILTER_OPTIONS): Physical, Flame, Frost, Volt.
  const order=(element:string)=>{const index=ELEMENT_FILTER_OPTIONS.findIndex(item=>item.id===element.toLowerCase());return index<0?99:index;};
  const mono=Object.keys(catalog.elementIcons).sort((a,b)=>order(a)-order(b));
  // A pair is unordered here (Physical / Flame, Frost / Volt): one chip per element set, named in filter order.
  const pairs=[...new Map((query.role==='tank'?[]:catalog.pairs).map(pair=>[...pair].sort((a,b)=>order(a)-order(b))).map(pair=>[trackId(pair),pair])).values()]
    .sort((a,b)=>order(a[0]!)-order(b[0]!));
  // Compare references (see CompareContext): from the loaded board, before search narrowing.
  const compareApi=useMemo<CompareApi>(()=>{
    const role=query.role;
    const pin=(id:string|null,entry?:GearTopEntry|PlayerTopEntry)=>{
      setCompare(id===IDEAL_PIN?{mode:'ideal',pin:null}:id?{mode:'pin',pin:id}:{mode:'off',pin:null});setPinnedEntry(id&&id!==IDEAL_PIN?entry??null:null);};
    const rowTrackOf=(entry:{track?:string})=>entry.track?parseTrack(entry.track,catalog):track;
    const name=(entry:GearTopEntry|PlayerTopEntry)=>`#${entry.rank} ${entry.player.nickname||copy.blankName}`;
    const isPlayer=(entry:GearTopEntry|PlayerTopEntry):entry is PlayerTopEntry=>Array.isArray(entry.gear);
    const pinnedGear=compare.mode==='pin'?gearEntries.find(entry=>gearPinId(entry)===compare.pin)??(pinnedEntry&&!isPlayer(pinnedEntry)&&gearPinId(pinnedEntry)===compare.pin?pinnedEntry:null):null;
    const pinnedPlayer=compare.mode==='pin'?playerEntries.find(entry=>playerPinId(entry)===compare.pin)??(pinnedEntry&&isPlayer(pinnedEntry)&&playerPinId(pinnedEntry)===compare.pin?pinnedEntry:null):null;
    const ideals=new Map<string,GearDraft>();
    const idealOf=(slot:string,rowTrack:ElementTrack)=>{const key=slot+'|'+trackId(rowTrack);let draft=ideals.get(key);if(!draft){draft=idealGearDraft(slot,rowTrack,catalog,role);ideals.set(key,draft);}return draft;};
    const same=(gain:number,label:string,reference:boolean,approximate:boolean,factors?:RowGain['factors']):RowGain=>({gain,label,reference,approximate,factors});
    return {mode:compare.mode,pinned:compare.pin,pin,
      gear:(entry,gear,rowTrack)=>{
        if(compare.mode==='off')return null;
        if(compare.mode==='ideal') {
          if(entry.ideal&&!entry.reference)return same(0,copy.ideal,true,false);
          const result=gearGain({gear,track:rowTrack},{gear:idealOf(entry.gear.slot,rowTrack),track:rowTrack},catalog,role);
          return same(result.gain,copy.ideal,false,false,result.factors);
        }
        // A piece compares only with rows of its own slot.
        const ref=pinnedGear&&pinnedGear.gear.slot===entry.gear.slot?pinnedGear:null;
        if(!ref)return null;
        if(ref===entry||(!entry.ideal&&!!entry.gear.id&&entry.gear.id===ref.gear.id))return same(0,name(ref),true,false);
        const result=gearGain({gear,track:rowTrack},{gear:entryGear(ref),track:rowTrackOf(ref)},catalog,role);
        return same(result.gain,name(ref),false,false,result.factors);
      },
      player:(entry,value,maximum,rowTrack)=>{
        if(compare.mode==='off')return null;
        if(compare.mode==='ideal') {
          if(entry.ideal&&!entry.reference)return same(0,copy.idealPlayer,true,true);
          return same(buildGain({value,track:rowTrack},{value:maximum,track:rowTrack},catalog,role),copy.idealPlayer,false,true);
        }
        const ref=pinnedPlayer;
        if(!ref)return null;
        if(ref===entry||(!entry.ideal&&!!entry.player.uid&&entry.player.uid===ref.player.uid))return same(0,name(ref),true,true);
        const refTrack=rowTrackOf(ref);
        return same(buildGain({value,track:rowTrack},{value:playerRowScore(ref,refTrack,catalog,role).total.value,track:refTrack},catalog,role),name(ref),false,true);
      }};
  },[compare,pinnedEntry,gearEntries,playerEntries,catalog,track,query.role,copy]);
  // The shared Ranking picker accepts Build/Players files; public JSON follows the same validation and import endpoint.
  async function uploadPlayers(file:File,kind:'players'|'build'=file.name.toLowerCase().endsWith(SEALED_FILES.build.extension)?'build':'players') {
    setUploading(true);setUploadNote('');
    try {
      // A foreign, broken or cut-off file is refused before it is sent.
      const body=await submitSealedFile<{collectorUid?:string;data?:BuildCapture;stored:number;duplicates:number;rejected:number;files:number;observationsOnly?:boolean;observed?:number;players?:{uid:string|null;name:string|null;gear:number}[]}>(kind,file,
        {url:kind==='build'?'/api/v1/build/import':'/api/v1/ranking/inspect',locale,onUpdate:setQueueJob});
      const uid=kind==='build'?body?.data?.capture.subject.uid:body?.collectorUid;
      if(uid)rememberBrowserOwner({uid,nickname:kind==='build'?body?.data?.profile.name??null:body?.players?.find(player=>player.uid===uid)?.name??null});
      // Stored without a single gear piece, a player never ranks: name them so a missing nickname is explained.
      const gearless=kind==='players'&&!body?.observationsOnly?(body?.players??[]).filter(player=>player.gear===0).map(player=>player.name||player.uid).filter((name):name is string=>!!name):[];
      const summary=kind==='build'?copy.t('Build uploaded.','Билд загружен.'):body?.observationsOnly?copy.t(`Test-server marks updated: ${body.observed??0} UIDs. Rejected: ${body.rejected??0}. Rankings unchanged.`,`Отметки тестового сервера обновлены: ${body.observed??0} UID. Отклонено: ${body.rejected??0}. Рейтинг не изменён.`):locale==='ru'?`Игроков: ${body?.files??0} · новых ${body?.stored??0} · повторов ${body?.duplicates??0} · отклонено ${body?.rejected??0}`
        :`Players: ${body?.files??0} · new ${body?.stored??0} · repeated ${body?.duplicates??0} · rejected ${body?.rejected??0}`;
      setUploadTone('info');setUploadNote(gearless.length?`${summary}. ${locale==='ru'?`Без гира (не попадут в топы): ${gearless.slice(0,10).join(', ')}${gearless.length>10?'…':''}`:`No gear (cannot rank): ${gearless.slice(0,10).join(', ')}${gearless.length>10?'…':''}`}`:summary);
      responseCache.clear();collapseAll();setVersion(value=>value+1);
    } catch(error) {setUploadTone('error');setUploadNote(queueMessage(error,locale==='ru',kind==='build'?copy.t('The build could not be imported','Не удалось загрузить билд'):copy.uploadFailed));}
    finally {setUploading(false);setQueueJob(null);}
  }

  return <RoleContext.Provider value={query.role}><ResistanceIconsContext.Provider value={query.role==='tank'?catalog.resistanceIcons:null}><BuildInspection locale={locale}><div ref={animationRoot} className={`${styles.page} filter-hover-preview`}>
    <ToolRail label={copy.title} items={[
      {id:'upload',label:uploading?copy.uploading:copy.uploadPlayers,icon:<RailGlyph name="import"/>,onClick:()=>{if(!uploading)playersInput.current?.click();},tone:'accent'},
      {id:'app',label:localeText(locale)('Capture app'),icon:<RailGlyph name="download"/>,onClick:()=>{setCaptureKind('players');setRailDialog('app');}},
      {id:'formulas',label:copy.calculationsHelp,icon:<RailGlyph name="formula"/>,onClick:()=>setRailDialog('formulas')},
      {id:'frames',label:frameAnimations.enabled?copy.t('Stop all animations on the page','Остановить все анимации на странице'):copy.t('Resume animations on the page','Возобновить анимации на странице'),
        icon:<RailGlyph name="equipment"/>,onClick:toggleFrameAnimations,active:!frameAnimations.enabled,tone:'gold'},
    ]}/>
    <UpdateDataModal isOpen={railDialog==='update'} onClose={()=>setRailDialog(null)} locale={locale} onApp={kind=>{setCaptureKind(kind);setRailDialog('app');}}/>
    <CaptureAppModal isOpen={railDialog==='app'} onClose={()=>setRailDialog(null)} locale={locale}
      upload={captureKind==='build'?{label:copy.t('Upload .tofbuild','Загрузить .tofbuild'),onClick:()=>buildInput.current?.click()}:{label:copy.t('Upload .tofplayers','Загрузить .tofplayers'),onClick:()=>playersInput.current?.click()}}/>
    {railDialog==='formulas'&&<CalculationsModal audience="ranking" isOpen onClose={()=>setRailDialog(null)} locale={locale} catalog={scoringCatalog(catalog)}
      element={allTracks?defaultElement:track[0]!} alteredFrom={allTracks||track[0]==='Altered'?defaultElement:track[0]!} role={query.role}
      contextDetails={<RankingScoreContext track={allTracks?null:track} locale={locale} copy={copy}/>}>
    </CalculationsModal>}
    <h1 className="sr-only">{copy.title}</h1>
    {/* Info Simulacra controls bar: search with the embedded Gear/Players switch, filter groups, counter and actions. */}
    <CatalogControls id="ranking-controls" ariaLabel={copy.filters} textSelectable>
      <CatalogSearch value={search} onChange={setSearch} debounceMs={0} serverModeSizing="content" placeholder={copy.searchPlaceholder} clearAriaLabel={copy.clearSearch}
        serverModeSlot={<span className={styles.modeSwitches}><span className={styles.roleDesktop}>{roleSwitch}</span><ModeSwitcher value={query.board} onChange={board=>update({board})} ariaLabel={copy.board} dataAttribute="data-board"
          options={[{value:'players',label:copy.players,tone:'sky'},{value:'gear',label:copy.gear,tone:'gold'}]}/></span>}/>
      <div className={styles.roleMobile}>{roleSwitch}</div>
      <CatalogControls.Middle><CatalogControls.Left className="info-ui">
        <RegionFilters regions={catalog.regions} value={query.dataset==='pioneer'?'pioneer':query.region} onChange={region=>update({region,dataset:undefined})} label={copy.region} allLabel={copy.all}>
          <FilterChip value="pioneer" variant="indigo" active={query.dataset==='pioneer'} onClick={()=>update({dataset:'pioneer',region:null,verified:false,places:'region',sort:'grv'})}>Pioneer</FilterChip></RegionFilters>
        {/* Tank: resistance icons, white until hovered or chosen (then the element colour, as in the build stat table). */}
        <div className={styles.elementChips} data-tank-icons={query.role==='tank'||undefined}><FilterGroup label={copy.element}><FilterChip value={ALL_TRACKS} variant="all" active={allTracks} onClick={()=>update({track:ALL_TRACKS})}>{copy.all}</FilterChip>
          {/* Pair tracks first, right after All (2026-10-08), then the single elements. */}
          {pairs.map(pair=>{const option=ELEMENT_FILTER_OPTIONS.find(item=>item.id===pair[0]!.toLowerCase()),path=getDualElementIconPath(pair[0],pair[1]);
          return <FilterChip key={trackId(pair)} value={trackId(pair)} variant={option?.variant} icon={path?gameAsset(path):undefined} iconAlt={trackLabel(pair,locale)} active={!allTracks&&track.length>1&&[...track].sort().join()===[...pair].sort().join()} onClick={()=>update({track:trackId(pair)})}>{chipLabel(pair,locale)}</FilterChip>;})}
          {mono.map(element=>{const option=ELEMENT_FILTER_OPTIONS.find(item=>item.id===element.toLowerCase());
          return <FilterChip key={element} value={element} variant={option?.variant} icon={query.role==='tank'?catalog.resistanceIcons[element]?.icon??elementIcon(element):elementIcon(element)} iconAlt={elementLabel(element,locale)} active={!allTracks&&trackId(track)===element} onClick={()=>update({track:element})}>{chipLabel([element],locale)}</FilterChip>;})}</FilterGroup></div>
        {query.board==='gear'&&<GearSlotChips gear={catalog.gear} value={query.slot} onChange={slot=>update({slot})} label={copy.slot} allLabel={copy.all} locale={locale}/>}
      </CatalogControls.Left>
      </CatalogControls.Middle>
      <CatalogControls.Bottom className={styles.statusBar}>
        <CatalogCounter count={shownCount} total={totalCount} entityLabel={query.board==='gear'?copy.items:copy.playersCount}
          formatString={(count,total,label)=><span>{copy.showing} <strong className={styles.counterNumber}>{count}</strong> {copy.of} <strong className={styles.counterNumber}>{total}</strong> {label}</span>}/>
        <span className={styles.barActions} onFocusCapture={revealHorizontalFocus}>
          {me.owner&&!query.dataset&&<button type="button" className={styles.barButton} data-tone="me" aria-pressed={me.active} aria-busy={me.status==='loading'} data-busy={me.status==='loading'||undefined} data-hint={copy.t('Show my place in this ranking','Показать моё место в этом рейтинге')} onClick={()=>{if(me.active){me.hide();return;}setSearch('');setUrlSearch('');me.reveal();setRevealAttempt(value=>value+1);}}><RailGlyph name="user"/>{copy.t('Me','Я')}</button>}
          <button type="button" className={styles.barButton} data-tone="update" aria-haspopup="dialog" disabled={uploading} onClick={()=>setRailDialog('update')}><RailGlyph name="help"/>{copy.t('Update data','Обновить данные')}</button>
          <BuildTooltip portal delayMs={1000} dismissOnAction className={buildStyles.itemTooltip} content={query.board==='gear'?copy.knownBase:copy.knownBaseBuild}>
            <label className={styles.barButton} data-tone="gold" data-checked={query.verified||undefined}><input className={styles.verifiedCheckbox} type="checkbox" checked={!!query.verified} onChange={event=>update({verified:event.target.checked})}/><svg className={styles.verifiedCheck} viewBox="0 0 10 10" aria-hidden="true"><path d="M2.4 5.2l1.7 1.7 3.6-3.8"/></svg>{copy.verifiedOnly}</label>
          </BuildTooltip>
          {/* Under All the perfect item is one reference for every element (see GenericElementContext). */}
          <BuildTooltip portal delayMs={1000} dismissOnAction className={buildStyles.itemTooltip} content={query.board==='gear'?copy.idealHint:copy.maxGrvBuildHint}>
          <button type="button" className={`${styles.barButton} ${buildStyles.rollValueTheme}`} data-grade="titan" data-tone="perfect" aria-pressed={ideal} onClick={()=>setIdeal(value=>!value)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.1l-3.9 2.2.9-4.3-3.3-3 4.4-.5z"/></svg><span className={styles.perfectLabel}>{query.board==='gear'?(ideal?copy.hideIdeal:copy.ideal):(ideal?copy.hideIdealPlayer:copy.idealPlayer)}</span></button>
          </BuildTooltip>

        </span>
        {/* The upload lives in the right rail (as on Build and Wish); this hidden field is its file picker. */}
        <input ref={playersInput} className="sr-only" type="file" accept={`${SEALED_FILES.players.extension},${SEALED_FILES.build.extension},.json`} disabled={uploading} aria-label={copy.uploadPlayers}
          onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void uploadPlayers(file);}}/>
        <input ref={buildInput} className="sr-only" type="file" accept=".tofbuild,.json" disabled={uploading} aria-label={copy.t('Upload .tofbuild','Загрузить .tofbuild')}
          onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void uploadPlayers(file,'build');}}/>
      </CatalogControls.Bottom>
    </CatalogControls>
    <section className={styles.board} aria-live="polite" aria-busy={loading}>
      <div className={styles.boardHead}>{!allTracks&&<TrackIcon track={track}/>}<h2>{query.dataset==='pioneer'?`${localeText(locale)('Pioneer')} · `:''}{allTracks?(query.board==='players'?(query.dataset==='pioneer'?copy.allServersElements:copy.allPlayersElements):copy.allElements):trackLabel(track,locale)}{query.board==='gear'&&query.slot?` · ${catalog.gear.find(item=>item.id===query.slot)?.name[locale]??''}`:''}</h2>
        {databaseEmpty&&!loading&&!query.dataset&&<Button size="sm" variant="ghost" aria-pressed={example} onClick={()=>{collapseAll();setExample(value=>!value);}}>{example?copy.hideExample:copy.showExample}</Button>}
        {(!query.dataset||query.board==='gear')&&<div className={styles.boardActions}>
          <CatalogSort presentation="inline" label={copy.t('Order','Порядок')} ariaLabel={copy.displayOrder}
            value={`${(query.board==='gear'&&query.sort?.startsWith('cs'))||(query.board==='players'&&query.sort?.startsWith('aug'))?'grv':query.sort??'grv'}:${query.region?query.places??'region':'region'}`}
            onChange={value=>{const [sort,places]=value.split(':');update({sort:sort as RankingQueryState['sort'],...(query.region?{places:places as RankingQueryState['places']}:{})});}}
            options={[
              {value:'grv',label:copy.t('GRV: High → Low','GRV: от лучшего')},
              {value:'grv-asc',label:copy.t('GRV: Low → High','GRV: от худшего')},
              ...(query.board==='players'&&!query.dataset?[{value:'cs',label:copy.t('CS: High → Low','CS: по убыванию')},{value:'cs-asc',label:copy.t('CS: Low → High','CS: по возрастанию')}]:[]),
              ...(query.board==='gear'?[{value:'aug',label:copy.t('Augmentations: High → Low','Аугментации: по убыванию')},{value:'aug-asc',label:copy.t('Augmentations: Low → High','Аугментации: по возрастанию')}]:[]),
              {value:'name-asc',label:copy.t('Nickname: A → Z','Ник: А → Я')},
              {value:'name-desc',label:copy.t('Nickname: Z → A','Ник: Я → А')},
            ].flatMap((option,index)=>(query.region?['region','global']:['region']).map((places,placeIndex)=>({value:`${option.value}:${places}`,label:option.label+(query.region?` · ${places==='global'?copy.globalPlaces:copy.regionalPlaces}`:''),dividerBefore:index>0&&placeIndex===0&&['cs','aug','name-asc'].includes(option.value)})))}/>

        </div>}
        <MaxGrv track={allTracks?null:track} slot={query.board==='gear'?query.slot:null} build={query.board==='players'} catalog={catalog} locale={locale} copy={copy} onHelp={()=>setRailDialog('formulas')}/>
</div>
      <QueueNotice job={queueJob} locale={locale}/>
      <Toast eventKey={uploadNote} tone={uploadTone} duration={8000}>{uploadNote}</Toast>
      {showExample&&<p className={styles.exampleNote}>{copy.example}</p>}
      <RankUrlContext.Provider value={rankUrls}><CompareContext.Provider value={compareApi}><OwnPlayerContext.Provider value={me.active&&!query.dataset?me.owner?.uid??null:null}>
      {loading?<LoadingState message={copy.loading}/>:
        query.board==='gear'&&gearShown.length?<GearTable entries={deferredGear.slice(0,shownRows)} track={track} showTrack genericIdeal={allTracks} catalog={catalog} locale={locale} copy={copy} open={open} toggle={toggleOpen}/>:
        query.board==='players'&&playersShown.length?<PlayerTable entries={deferredPlayers.slice(0,shownRows)} track={track} showTrack genericIdeal={allTracks} catalog={catalog} locale={locale} copy={copy} open={open} toggle={toggleOpen}/>:
        <EmptyState title={result?.error?copy.t('Ranking temporarily unavailable','Рейтинг временно недоступен'):query.verified?copy.t('No verified matches','Нет совпадений с галочкой'):copy.emptyTitle} description={<>{result?.error?copy.t('The API is unavailable or still starting. Retry once it is ready.','API недоступен или ещё запускается. Повторите загрузку после запуска.'):query.verified?copy.t('Turn off Verified only or change the filters. Original GRV places are preserved.','Выключите «Только verified» или измените фильтры. Исходные места по GRV сохраняются.'):copy.emptyText}{result?.response?.available===false?<><br/>{copy.unavailable}</>:null}{result?.error?<><br/>{copy.error}</>:null}</>}
          action={result?.error?<Button onClick={()=>setRankingAttempt(value=>value+1)}>{copy.t('Retry loading','Повторить загрузку')}</Button>:<Link className={styles.uploadLink} href="/tools/build/">{copy.upload}</Link>}/>}
      </OwnPlayerContext.Provider></CompareContext.Provider></RankUrlContext.Provider>
    {/* Next page loads when the row LOAD_AHEAD from the end (or this marker) shows up. */}
      <div ref={moreRef} className={styles.loadMore} aria-hidden={!loadingMore&&!moreError}>{loadingMore?<Spinner size="sm"/>:moreError?<Button size="sm" variant="ghost" onClick={()=>{setMoreState(null);setMoreAttempt(value=>value+1);}}>{copy.t('Retry loading','Повторить загрузку')}</Button>:null}</div>
    </section>
  </div></BuildInspection></ResistanceIconsContext.Provider></RoleContext.Provider>;
}
