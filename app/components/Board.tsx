"use client";

import { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";
import { CardArt } from "@/app/components/CardArt";
import { FixedTooltip } from "@/app/components/CardCatalog";
import { BOLD_LOCATION_ART_IDS, LocationArt } from "@/app/components/LocationArt";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, centerEffectDescription, KINGSLAYER_BASE_VALUE, KINGSLAYER_INSTANCE_ID } from "@/lib/content/centerEffects";
import { adjacentPositions, getAdjacentCards, inBounds, isOwnerlessPosition, isPositionFaceUp, parsePosKey } from "@/lib/engine/board";
import { PLAYER_COLOR_CLASSES, PLAYER_TEXT_COLOR_CLASSES } from "@/lib/config/players";
import { computeNegatedInstanceIds, computePlagueInfection, flipBoostTargets, flipDisruptionTargets, ResolvedCard } from "@/lib/engine/resolution";
import { isFlipUnlocked } from "@/lib/engine/turns";
import { CardId, CardInstance, GameState, Position, posKey } from "@/lib/engine/types";
import { clearActiveTooltip, setActiveTooltip, toggleActiveTooltip, useActiveTooltipId } from "@/app/hooks/activeTooltip";
import { useAssetExists } from "@/app/hooks/useAssetExists";
import { useHallOfFortunesReveal } from "@/app/hooks/useHallOfFortunesReveal";
import { useHasHover } from "@/app/hooks/useHasHover";
import { BreakdownPopup } from "./scoreBreakdown";

/** Index-based, not identity-based -- same seat position always gets the same color regardless of who (human or AI, single- or multiplayer) sits there. */
function ownerColorClass(state: GameState, ownerId: string): string {
  const idx = state.players.findIndex((p) => p.id === ownerId);
  return PLAYER_COLOR_CLASSES[idx] ?? "border-zinc-400";
}

/** Same idea as ownerColorClass, but a plain `text-*` color -- for the card-back diamond (see card-back-pattern), which reads its color via `bg-current` rather than the button's own border/background classes. */
function ownerTextColorClass(state: GameState, ownerId: string): string {
  const idx = state.players.findIndex((p) => p.id === ownerId);
  return PLAYER_TEXT_COLOR_CLASSES[idx] ?? "text-zinc-400";
}

/** Inclusive integer range [start, end] -- empty if start > end (e.g. a 0-width quadrant on a tiny board). */
function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

/**
 * A handful of Engine cards get a one-shot icon flourish that plays only during the
 * card's own mid-flip reveal (each one finishes well within FLIP_ANIMATION_MS, AND
 * doesn't involve its own translate/3D transform that would compound badly with the
 * parent's simultaneous rotateY flip, AND stays within its own icon's bounding box --
 * unlike Pretender's spin, Footman's slide, Commander's charge, Mercenary's
 * coin-flip, Beacon's hop, Berserker's hydra-split, or Giant Bear's/Warlord's
 * drops, which all need their own longer-lived state (and, for Berserker/Giant Bear/
 * Warlord/Gloryseeker, a separate sibling overlay outside the card's own
 * overflow-hidden button, since each of those spills visibly past the icon's own box)
 * -- see each one's own doc comment near flippingIds). See each class's own keyframe
 * in globals.css for the flavor behind it: Bannerman/Hornblower raises up mid-call.
 * Everyone else in the "Engine flourish" set is NOT here -- see
 * slideIds/chargeIds/coinFlipIds/igniteIds/hopIds/hydraIds/chargePulseIds near
 * flippingIds instead.
 */
const MID_FLIP_ICON_CLASS: Partial<Record<CardId, string>> = {
  Bannerman: "card-icon-raise-call",
};

export interface BoardGridProps {
  state: GameState;
  /** Who's looking -- "You" vs. everyone else, and what a still-hidden card's tooltip says, are both relative to this, not a hardcoded identity. Single-player passes its fixed HUMAN id; a networked client passes whatever playerId the server assigned it. */
  viewerId: string;
  /** Display name for a given ownerId -- caller-supplied so this component doesn't need to know single-player's "You"/AI_NAMES scheme vs. multiplayer's lobby-chosen names. */
  nameFor: (ownerId: string) => string;
  legalCellKeys: Set<string>;
  flipTargetIds: Set<string>;
  selectedInstanceId: string | null;
  dragOverKey: string | null;
  revealAll: boolean;
  /** Scoring breakdown per instanceId, once the game has ended -- see EndScreen. */
  resolvedCards?: Map<string, ResolvedCard>;
  /** Kingslayer only -- instanceIds of the card(s) it hit, once the game has ended -- see EndScreen's own "Kingslayer hit: ..." line, which this mirrors on the tile's own hover instead of a separate summary. */
  kingslayerHit?: string[];
  onCellClick: (pos: Position) => void;
  onCellDragOver: (e: React.DragEvent, key: string) => void;
  onCellDragLeave: () => void;
  onCellDrop: (e: React.DragEvent, pos: Position) => void;
  /**
   * True while it's the viewer's own turn -- adds a pulsing glow around the board
   * itself (see the `.turn-glow` class in globals.css). Applied directly to this
   * component's own root element (which already computes its exact rendered width via
   * inline style) rather than a wrapping `<div>` a caller might add -- a wrapper with
   * no explicit width of its own breaks this component's `width: min(100%, ...)` calc
   * (the percentage has nothing definite to resolve against, collapsing the board to
   * its min-content size) the moment it's the containing block instead of this
   * component's real parent.
   */
  highlighted?: boolean;
  /**
   * Bypasses legalCellKeys/flipTargetIds entirely -- every empty cell accepts a click
   * and every occupied cell (face-up or face-down) does too, regardless of whose turn
   * it is or the normal "only face-down cards are flip-targets" rule. Only sandbox
   * mode sets this (see app/sandbox/page.tsx, which needs to place/toggle/remove any
   * card freely) -- omitted (falsy) everywhere else, so every real game's normal
   * legality gating is completely unaffected.
   */
  forceAllClickable?: boolean;
  /**
   * Makes every occupied cell's card draggable and calls this when a drag off of it
   * starts -- only sandbox mode sets this (see app/sandbox/page.tsx, which lets a
   * placed card be dragged to a new cell, or off the board entirely to remove it).
   * Omitted (falsy) everywhere else, so no real game's board cards become draggable.
   */
  onCardDragStart?: (e: React.DragEvent, instanceId: string, pos: Position) => void;
  /** Paired with onCardDragStart -- fires when that drag ends, wherever it ends. `e.dataTransfer.dropEffect` is still "none" here if it was never accepted by a drop target (see onCellDragOver), which is how sandbox tells "dropped back onto some cell" apart from "dragged off the board entirely." */
  onCardDragEnd?: (e: React.DragEvent) => void;
}

export function BoardGrid({
  state,
  viewerId,
  nameFor,
  legalCellKeys,
  flipTargetIds,
  selectedInstanceId,
  dragOverKey,
  revealAll,
  resolvedCards,
  kingslayerHit,
  forceAllClickable,
  onCellClick,
  onCellDragOver,
  onCellDragLeave,
  onCellDrop,
  onCardDragStart,
  onCardDragEnd,
  highlighted: turnHighlighted,
}: BoardGridProps) {
  const { width, height } = state.config.boardBounds;
  const rows = Array.from({ length: height }, (_, y) => y);
  const cols = Array.from({ length: width }, (_, x) => x);
  const activeTooltipId = useActiveTooltipId();
  const hasHover = useHasHover();
  // Checked once for the whole board, not per-cell -- every ownerless tile shares the
  // same location, so there's no need to probe per-cell, and hooks can't be called
  // conditionally inside the per-cell map below anyway. Defaults to false (today's
  // plain label/tinted-box rendering) until an SVG is confirmed to exist at
  // public/location-art/<centerEffect>.svg -- most locations don't have one yet, and
  // this is exactly what keeps their rendering unchanged with no flash.
  const hasLocationArt = useAssetExists(`/location-art/${state.config.centerEffect}.svg`);
  // A location can optionally split its icon across left/right-of-center ownerless
  // tiles instead of repeating one icon on both (see Dragon Gate's own left/right
  // half-gate art) -- these two checks are harmless 404s for every other location,
  // which just falls back to hasLocationArt above.
  const hasLeftLocationArt = useAssetExists(`/location-art/${state.config.centerEffect}-left.svg`);
  const hasRightLocationArt = useAssetExists(`/location-art/${state.config.centerEffect}-right.svg`);
  // Only one tooltip is ever open anywhere in the app at once (see activeTooltip.ts),
  // so a single locally-held rect is enough -- same reasoning as CardCatalog's own
  // activeRect. Feeds FixedTooltip (a portal, positioned `fixed` from real screen
  // coordinates and clamped to the viewport) instead of a plain `absolute` tooltip --
  // a board cell near the screen edge (common on a narrow phone) was otherwise
  // rendering half off-screen, unreadable.
  const [activeRect, setActiveRect] = useState<DOMRect | null>(null);
  // EndScreen's per-card breakdown rows share this same tooltip store, namespaced
  // `endscreen:${instanceId}` (see EndScreen.tsx) -- reusing that instead of adding a
  // separate onHover callback/prop means hovering (or tapping, on touch) a row in the
  // end-of-game breakdown highlights that exact card here for free, with the same
  // hover-vs-tap and click/scroll-to-dismiss behavior every other tooltip already has.
  const endScreenPrefix = "endscreen:";
  const hoveredEndCardInstanceId = activeTooltipId?.startsWith(endScreenPrefix) ? activeTooltipId.slice(endScreenPrefix.length) : null;
  // Same idea, but for a whole player rather than one card: TurnOrderTracker's row
  // hover (`turnorder:${playerId}`) and EndScreen's per-player header hover
  // (`player:${playerId}`) both reuse the same shared tooltip-id store, so hovering
  // (or tapping, on touch) either one highlights every one of that player's cards
  // here, not just a single card.
  const turnOrderPrefix = "turnorder:";
  const playerRowPrefix = "player:";
  const hoveredPlayerId = activeTooltipId?.startsWith(turnOrderPrefix)
    ? activeTooltipId.slice(turnOrderPrefix.length)
    : activeTooltipId?.startsWith(playerRowPrefix)
      ? activeTooltipId.slice(playerRowPrefix.length)
      : null;

  // Which cards are mid-flip-reveal right now -- see FLIP_ANIMATION_MS and the
  // .card-flip-* classes in globals.css for the actual 3D animation. Detected by
  // diffing against the previous render's face-up snapshot (below), not by any signal
  // the reducer itself emits -- this keeps the animation purely a rendering concern,
  // oblivious to *why* a card flipped (a real flip action, an AI's move, a forceFaceUp
  // card like Cyclops getting placed, Reckoning's redraw, anything). A card's very
  // FIRST sighting only counts once this component has already rendered the board at
  // least once (see hasMountedRef) -- otherwise reconnecting mid-game (a page refresh,
  // a spectator opening the display view) would see every already-revealed card play
  // the reveal animation at once, since they'd all be "new" to a freshly mounted
  // snapshot. After that first render, a card's first-ever sighting genuinely does
  // mean "just placed this turn" (the board starts empty and only ever grows one
  // placement at a time), so a forceFaceUp card's placement now reveals exactly like a
  // real flip does. Refs are only ever touched inside this effect (never during
  // render, per this project's stricter react-hooks/refs rule), so the
  // setState-in-effect it does trigger is accepted here the same way every page's own
  // mount-detection effect already does.
  const FLIP_ANIMATION_MS = 500;
  // A forceFaceUp card (Cyclops) never has a face-down state to rotate away from --
  // it arrives already revealed the instant it's placed, not flipped later mid-game --
  // so instead of the two-face 3D flip every other card's later flip uses, a larger
  // copy of just its icon pops up out of the real (unchanged) card and looms above the
  // board briefly (see .card-rise-overlay in globals.css). Matches that CSS
  // animation's own duration so the overlay never gets cut off mid-animation.
  const RISE_ANIMATION_MS = 700;
  // Giant Bear (Exile) only -- the reverse of Cyclops's rise: instead of an icon
  // popping up out of an already-visible card and fading away, its icon starts large,
  // high, and invisible, then drops down onto the (briefly icon-less) card and
  // settles into place, like a paw stomping down. Still a REAL flip first (Exile has
  // a genuine face-down state, unlike forceFaceUp Cyclops), so this plays inside the
  // same reveal-back-face content the normal 3D flip already shows (see
  // renderFaceUpContent), not instead of it.
  const PAW_DROP_MS = 550;
  // Usurper (Pretender) only -- the card itself does the same plain flip as always
  // (FLIP_ANIMATION_MS), but its icon keeps spinning in place afterward, several full
  // turns each slower than the last (see .card-icon-multi-spin in globals.css), like
  // a coin losing momentum and settling flat. Longer than the card's own flip, so it
  // keeps going into the settled face-up render, not just the mid-flip reveal.
  const PRETENDER_SPIN_MS = 2400;
  // Warlord only -- same "hideIcon, drop a bigger copy in from above" idea as Giant
  // Bear's paw drop, but harder and faster (a slam, not a gentle drop), and paired
  // with a one-shot shockwave ring pulsing outward right as it lands (see
  // .card-slam-drop/.card-slam-shockwave in globals.css) -- reads as an impact, not
  // just an arrival.
  const SLAM_MS = 450;
  // Gloryseeker (Pyre-Bird) only -- same "hideIcon, overlay a separate copy" trick as
  // Giant Bear/Warlord above, but longer than a single flip-duration class allows: the
  // card is left blank through its own reveal, then a fire-colored copy of the icon
  // materializes out of nothing and chars down to black before handing off to the real
  // (normally colored) icon underneath (see .card-ignite-materialize in globals.css).
  // No rotation at all, unlike Pretender/Giant Bear/Warlord's own overlays.
  const IGNITE_MS = 1300;
  // Footman (Hoplite) only -- a translateX slide-in nested inside the parent's own 3D
  // rotateY flip (.card-flip-face-back) visibly warped/juddered once it ran long
  // enough to be noticeable (a 2D translate compounding with an ancestor that's
  // rotating in 3D under a `perspective`, mid-rotation, doesn't read as a clean
  // slide). So instead: the icon slot stays blank through the whole 3D flip (see
  // hideIcon below, same idea as Giant Bear/Warlord), and only once the card has
  // fully settled into its plain, non-3D render does the icon slide in from the left
  // -- ordinary DOM, no rotated ancestor, so the motion reads exactly as it looks.
  // NOTE: this clock starts at the same moment as the flip itself (t=0), but the
  // slide's own CSS animation doesn't start PLAYING until the settled render mounts
  // at FLIP_ANIMATION_MS -- so this has to cover the flip's own duration plus the
  // slide's full 0.55s animation, not just the animation alone, or slideIds (and the
  // class it drives) gets cleared mid-slide, yanking the "forwards" fill and snapping
  // the icon instantly to its resting position.
  const SLIDE_MS = FLIP_ANIMATION_MS + 550;
  // Beacon (Nightjar) only -- the icon itself stays visible through the flip (see
  // renderFaceUpContent's hideIcon calls -- Beacon is deliberately left out of
  // both), but a translateY hop nested inside the parent's own 3D rotateY flip
  // judders the same way Footman's translateX slide did, so the hop animation
  // itself still only starts once the card has settled. Same
  // FLIP_ANIMATION_MS-plus-own-duration accounting as SLIDE_MS above, for the
  // same reason (its own CSS animation doesn't start playing until the settled
  // render mounts at FLIP_ANIMATION_MS).
  const HOP_MS = FLIP_ANIMATION_MS + 1300;
  // Commander (Hipparch) only -- same reasoning/treatment as Footman's slide above
  // (a translateX nested inside the parent's simultaneous rotateY flip read as a
  // warped flicker, not a clean charge): icon stays blank through the 3D flip, then
  // charges in once the card has settled into its plain render.
  const CHARGE_MS = FLIP_ANIMATION_MS + 550;
  // Mercenary (Conciliator) only -- same reasoning/treatment as Footman's slide and
  // Commander's charge above: this icon's own perspective+rotateY coin-flip,
  // compounded with the parent's simultaneous rotateY flip, read as a flicker rather
  // than a clean spin, so it also stays blank through the 3D flip and only plays
  // once settled.
  const COIN_FLIP_MS = FLIP_ANIMATION_MS + 550;
  // Berserker (Hydra) only -- two extra ghost-head copies slide out and fade (see
  // .card-icon-hydra-ghost-left/-right in globals.css), offset far enough to
  // actually read as separate heads, which the card's own button (overflow-hidden,
  // so its content never spills into neighboring cells) was clipping almost
  // entirely -- same "overlay a separate copy outside the button" idea as Giant
  // Bear's paw drop/Warlord's slam, whose overlay is a sibling of the button and so
  // isn't clipped by it. Unlike those, this can start at the same moment as the flip
  // itself (not delayed to wait for settling) since the overlay isn't nested inside
  // the 3D-rotated .card-flip-face-back at all.
  const HYDRA_MS = 500;
  // Plague Rat (PlagueRat) only -- same "extra real CardArt copies, not a
  // filter/mask trick" idea as Hydra's ghost-split above, but scattering outward
  // in five directions and fading away instead of converging back into one --
  // a plague spreading outward rather than a hydra's heads merging back.
  const PLAGUE_SCATTER_MS = 550;
  // Facestealer (Infiltrator) only -- bad for its owner to get caught: the real icon
  // disappears completely (see hideIcon below, same idea as Giant Bear/Warlord)
  // while the borrowed face cracks into four quadrant pieces that fall away and
  // fade (see .card-icon-crumble-piece-1..4 in globals.css), then the real icon
  // reappears once the pieces are gone. An earlier version tried dimming the real
  // icon in place instead of hiding it outright, which visibly popped back to full
  // opacity at the mid-flip-to-settled handoff -- hiding it outright avoids that
  // entirely, no dim/fade needed.
  const CRUMBLE_MS = 650;
  // Noctule (PlagueBearer) only -- flies in diagonally from the bottom-right corner
  // and settles into the box, like a bat swooping in. Same "blank through the 3D
  // flip, animate only once settled" treatment as Footman's slide/Commander's
  // charge above -- a diagonal translate nested inside the parent's own
  // simultaneous rotateY flip would judder the same way those did.
  const NOCTULE_FLY_IN_MS = FLIP_ANIMATION_MS + 650;
  // Doomherald (Chronicler) only -- same "icon pops up out of the card and looms
  // above the board" idea as Cyclops's own rise above, just a real flip first (a
  // genuine face-down state, unlike forceFaceUp Cyclops) and bigger/longer-lived
  // (see .card-herald-rise-overlay in globals.css). Doesn't hide the real icon
  // underneath either, same as Cyclops -- the overlay just pops a bigger copy on
  // top and fades, revealing the same icon already there.
  const HERALD_RISE_MS = 900;
  // Lictor (Suppressor) only -- a rotation swing nested inside the parent's own 3D
  // rotateY flip would judder the same way Footman's/Commander's translates did, so
  // this uses the same treatment: icon stays blank through the 3D flip, then swings
  // once the card has settled into its plain, non-3D render.
  const SWORD_SWING_MS = FLIP_ANIMATION_MS + 600;
  // Earthshaker only -- its OWN reveal, not the ground-shake wobble it inflicts on
  // its targets (see earthshakenIds elsewhere) -- a trumpet-blast: a quick icon
  // shake plus a sibling ring reading as a single sound-wave pulse (see
  // .card-icon-trumpet-shake/.card-trumpet-soundwave in globals.css, both 0.6s).
  // Starts at the same moment as the flip itself (t=0), same as
  // earthshakenIds/DISRUPTION_FLASH_MS above, so it lines up with the moment its
  // targets start visibly shaking rather than lagging behind until the card
  // settles -- unlike Footman's slide/Commander's charge, a rotate+scale icon
  // shake (not a translate) reads fine nested inside the parent's own rotateY
  // flip, so it doesn't need their "blank through the flip" treatment.
  const TRUMPET_MS = 700;
  // Inquisitor (Truthseeker) only -- the torch icon swings up through two
  // U-shaped arcs (top-left to top-right and back) before settling to rest, no
  // color change at all (a red flash, a violet scale-pulse, a vertical blink, a
  // full 360 spin, and a straight left-right sweep were all tried first and
  // none of them landed). Applied ONLY at the settled call site, not the
  // mid-flip one -- applying it at both (like iconSpinClass/hopClass) meant its
  // 1.3s swing had already reached its first arc's peak before the mid-flip's
  // back face ever became visible (which only happens roughly halfway through
  // the parent's own 500ms flip), so it'd read as already mid-swing the instant
  // it appeared instead of starting from rest. Settled-only means the viewer
  // always sees the normal icon first, then the swing plays after.
  const TRUTHGAZE_MS = FLIP_ANIMATION_MS + 1300;
  // Skysplitter (Zeus-Born) only -- a bright pulse, flavor for "+1 per round
  // elapsed" (it only ever gets stronger from here). Applied ONLY at the settled
  // call site, same reasoning/timing as Inquisitor's flame flash above -- the
  // viewer sees the card finish flipping first, then the pulse plays after, rather
  // than the pulse racing the reveal itself. Slower than the original mid-flip
  // version too (was 0.5s), now that it's not competing with the flip's own 500ms.
  const CHARGE_PULSE_MS = FLIP_ANIMATION_MS + 1000;
  // Mirror Pool only -- a one-shot celebratory glow on the Pool's own ownerless
  // tiles when a mirrored pair is newly revealed as a matching type (not a
  // continuous status indicator -- an earlier version stayed lit for as long as
  // the match remained face-up, which in practice meant forever once revealed,
  // since cards don't flip back down). Powers off after this, regardless of
  // whether the match is technically still on the board.
  const POOL_GLOW_MS = 3000;
  // Contested Lands (frontier) only -- same one-shot "flash then power off"
  // treatment as Mirror Pool's own glow above, triggered by a newly PLACED card
  // (any face state) landing adjacent to an opposing player's card, matching the
  // location's own "+1 per distinct opposing neighbor" rule.
  const RUIN_GLOW_MS = 3000;
  // Slightly longer than the flip itself and starting from the same moment -- reads as
  // "the flip caused this," not a separate, disconnected blink, while still giving a
  // beat after the card settles for the affected cells to actually register.
  const DISRUPTION_FLASH_MS = 800;
  const hasMountedRef = useRef(false);
  const prevFaceUpRef = useRef<Map<string, boolean>>(new Map());
  // See the comment near where these are used, below -- poolGlowIds/ruinGlowIds
  // manage their own timers independently of the shared `flash` helper's
  // cleanups array, since that cleanup would otherwise cancel their pending
  // removal whenever anything else on the board changes in the meantime.
  const poolGlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ruinGlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The Frontier (borderlands) only -- its single Outpost tile glows every time a
  // card lands on the board's edge (occupancy is always public, so this doesn't
  // care about face state), same one-shot flash-then-power-off treatment as Ruin's
  // own glow. Once every edge cell is finally occupied, the Outpost has nothing
  // left to watch: instead of glowing forever it crumbles (reusing the same
  // real-icon-copy .card-icon-crumble-piece-1..4 technique as Facestealer/
  // Infiltrator's own crumble) and stays permanently empty after -- a one-time,
  // one-way transition, not a Set/epoch since it can only ever happen once per
  // game (occupied cells never become vacant again).
  const OUTPOST_GLOW_MS = 3000;
  const outpostGlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outpostCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevEdgeFullRef = useRef(false);
  const prevEdgeOccupiedCountRef = useRef(0);
  const [outpostGlowEpoch, setOutpostGlowEpoch] = useState(0);
  const [outpostCrumbling, setOutpostCrumbling] = useState(false);
  const [outpostCollapsed, setOutpostCollapsed] = useState(false);
  // No Man's Land (Trench) only -- each of its 4 corner tiles gets a one-shot
  // rotateY spin (reusing .card-icon-multi-spin, same rotation Usurper/Pretender's
  // own icon-spin uses) the moment every real cell in that corner's own quadrant
  // (split by the center row/column, same cross the location's own -2 debuff
  // runs along) is filled. Purely positional/occupancy-based, so no hidden-info
  // concern. Keyed by a fixed per-corner id ("tl"/"tr"/"bl"/"br"), add-only -- a
  // quadrant can only ever transition from not-full to full once per game, so
  // unlike the per-card Sets above this never needs its entries removed again.
  const [trenchSpinCorners, setTrenchSpinCorners] = useState<Set<string>>(new Set());
  const prevQuadrantFullRef = useRef<Record<string, boolean>>({ tl: false, tr: false, bl: false, br: false });
  // No Man's Land (Trench) -- every Trench tile flashes together whenever a card
  // lands on the center's row/column, same one-shot flash-then-power-off shape as
  // Contested Lands'/the Outpost's own glows.
  const trenchGlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trenchGlowEpoch, setTrenchGlowEpoch] = useState(0);
  // Hall of Fortunes (reckoning) -- the 3 real Pillar tiles themselves (not a
  // separate overlay elsewhere on the page) spin and morph into the viewer's own
  // freshly-drawn 3-card offer, hold briefly, then revert back to plain Pillars.
  // See useHallOfFortunesReveal's own doc comment -- the page-level Hand call
  // site calls the SAME hook to delay showing/allowing the new offer until this
  // finishes, so the cards never look "already available" while the Pillars are
  // still pretending to draw them.
  const { phase: hofPhase, displayCards: hofDisplayCards } = useHallOfFortunesReveal(state, viewerId);
  const [flippingIds, setFlippingIds] = useState<Set<string>>(new Set());
  const [risingIds, setRisingIds] = useState<Set<string>>(new Set());
  const [pawDropIds, setPawDropIds] = useState<Set<string>>(new Set());
  const [pretenderSpinIds, setPretenderSpinIds] = useState<Set<string>>(new Set());
  const [slamIds, setSlamIds] = useState<Set<string>>(new Set());
  const [igniteIds, setIgniteIds] = useState<Set<string>>(new Set());
  const [slideIds, setSlideIds] = useState<Set<string>>(new Set());
  const [hopIds, setHopIds] = useState<Set<string>>(new Set());
  const [chargeIds, setChargeIds] = useState<Set<string>>(new Set());
  const [coinFlipIds, setCoinFlipIds] = useState<Set<string>>(new Set());
  const [hydraIds, setHydraIds] = useState<Set<string>>(new Set());
  const [plagueScatterIds, setPlagueScatterIds] = useState<Set<string>>(new Set());
  const [crumbleIds, setCrumbleIds] = useState<Set<string>>(new Set());
  const [noctuleFlyInIds, setNoctuleFlyInIds] = useState<Set<string>>(new Set());
  const [heraldRiseIds, setHeraldRiseIds] = useState<Set<string>>(new Set());
  const [swordSwingIds, setSwordSwingIds] = useState<Set<string>>(new Set());
  const [trumpetIds, setTrumpetIds] = useState<Set<string>>(new Set());
  const [truthgazeIds, setTruthgazeIds] = useState<Set<string>>(new Set());
  const [chargePulseIds, setChargePulseIds] = useState<Set<string>>(new Set());
  // Not per-instance like the others -- there's only ever one Pool, so this is
  // just a boolean flash (via the same `flash` helper below, using a single
  // sentinel id) rather than a Set keyed by card instanceId.
  // A monotonically increasing "epoch" rather than a boolean/Set -- used as a React
  // `key` on the glow overlay below, so retriggering while a previous glow is still
  // playing forces a fresh DOM node (and therefore a genuinely restarted CSS
  // animation) instead of silently reusing the same element with the same
  // className string, which React (and the browser) would treat as no change at
  // all and never replay.
  const [poolGlowEpoch, setPoolGlowEpoch] = useState(0);
  // Same "epoch, not boolean" reasoning as poolGlowEpoch above -- Contested Lands
  // has multiple Ruin tiles, but they all flash together as one location-wide event.
  const [ruinGlowEpoch, setRuinGlowEpoch] = useState(0);
  // Neighbor/row/col cells a just-flipped card (Earthshaker, Chronicler/Doomherald,
  // Suppressor/Lictor, Truthseeker/Inquisitor, PlagueBearer, PlagueRat, ...) actually
  // hits -- see flipDisruptionTargets. Flashed with a red pulse (.card-disrupted in
  // globals.css) so a disruptive card's reveal reads as *why* it matters, not just
  // that a card turned over.
  const [disruptedIds, setDisruptedIds] = useState<Set<string>>(new Set());
  const [earthshakenIds, setEarthshakenIds] = useState<Set<string>>(new Set());
  // Green mirror of disruptedIds -- see flipBoostTargets. Includes the flipped card
  // itself (a self-buff, e.g. Gloryseeker's own +3 while face-up) as well as neighbors
  // a card like Hornblower buffs on flip. Flashed with .card-boosted in globals.css.
  const [boostedIds, setBoostedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevFaceUpRef.current;
    const next = new Map<string, boolean>();
    // A real, later flip (was genuinely face-down at some earlier render) vs. a card
    // arriving already face-up the moment it's first seen (only ever a forceFaceUp
    // card's placement, since the board starts empty and only grows one placement at
    // a time -- see hasMountedRef's own doc comment above for why "first sighting"
    // only counts post-mount) -- same underlying "just revealed" moment, but they get
    // two different animations (see FLIP_ANIMATION_MS/RISE_ANIMATION_MS above).
    const newlyFlipped: string[] = [];
    const newlyRisen: string[] = [];
    // Any card whose instanceId wasn't tracked at all last render -- i.e. it was
    // just placed this render, face-up or face-down (unlike newlyRisen above,
    // which only counts a forceFaceUp card's first sighting). Drives Contested
    // Lands' own Ruin glow below, which cares about placement adjacency, not flips.
    const newlyPlaced: string[] = [];
    for (const [key, card] of state.board.entries()) {
      const prevValue = prev.get(card.instanceId);
      if (card.faceUp && prevValue === false) newlyFlipped.push(key);
      else if (card.faceUp && hasMountedRef.current && prevValue === undefined) newlyRisen.push(key);
      if (hasMountedRef.current && prevValue === undefined) newlyPlaced.push(key);
      next.set(card.instanceId, card.faceUp);
    }
    prevFaceUpRef.current = next;
    hasMountedRef.current = true;
    const justRevealed = [...newlyFlipped, ...newlyRisen];
    if (justRevealed.length === 0 && newlyPlaced.length === 0) return;

    // One-shot flash: adds `ids` to whichever set `setter` manages, then removes
    // exactly those ids again after `ms` -- shared by the flip/rise/disruption/boost
    // flashes below, which all follow this same "add now, clean up later" shape.
    const flash = (ids: string[], setter: Dispatch<SetStateAction<Set<string>>>, ms: number): (() => void) | undefined => {
      if (ids.length === 0) return undefined;
      setter((current) => new Set([...current, ...ids]));
      const timer = setTimeout(() => {
        setter((current) => {
          const remaining = new Set(current);
          for (const id of ids) remaining.delete(id);
          return remaining;
        });
      }, ms);
      return () => clearTimeout(timer);
    };

    const newlyFlippedIds = newlyFlipped.map((key) => state.board.get(key)!.instanceId);
    const newlyRisenIds = newlyRisen.map((key) => state.board.get(key)!.instanceId);
    const newlyPawDropped = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Exile").map((key) => state.board.get(key)!.instanceId);
    const newlyPretenderSpin = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Pretender").map((key) => state.board.get(key)!.instanceId);
    const newlySlammed = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Warlord").map((key) => state.board.get(key)!.instanceId);
    const newlyIgnited = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Gloryseeker").map((key) => state.board.get(key)!.instanceId);
    const newlySlid = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Footman").map((key) => state.board.get(key)!.instanceId);
    const newlyHopped = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Beacon").map((key) => state.board.get(key)!.instanceId);
    const newlyCharged = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Commander").map((key) => state.board.get(key)!.instanceId);
    const newlyCoinFlipped = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Mercenary").map((key) => state.board.get(key)!.instanceId);
    const newlyHydraSplit = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Berserker").map((key) => state.board.get(key)!.instanceId);
    const newlyPlagueScattered = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "PlagueRat").map((key) => state.board.get(key)!.instanceId);
    const newlyCrumbled = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Infiltrator").map((key) => state.board.get(key)!.instanceId);
    const newlyNoctuleFlownIn = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "PlagueBearer").map((key) => state.board.get(key)!.instanceId);
    const newlyHeraldRisen = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Chronicler").map((key) => state.board.get(key)!.instanceId);
    const newlyTrumpeted = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Earthshaker").map((key) => state.board.get(key)!.instanceId);
    // Lictor (Suppressor) only -- the sword swing only plays when its own ability is
    // actually active on reveal (3+ adjacent occupied cells, same condition as
    // negatesNeighborsIf/flipDisruptionTargets) -- an inert Lictor with too few
    // neighbors shouldn't act like it's doing anything.
    const newlySwordSwing = newlyFlipped
      .filter((key) => {
        const card = state.board.get(key)!;
        return (
          card.cardId === "Suppressor" &&
          (CARD_DEFS[card.cardId].negatesNeighborsIf?.({ board: state.board, bounds: state.config.boardBounds, pos: parsePosKey(key) }) ?? false)
        );
      })
      .map((key) => state.board.get(key)!.instanceId);
    const newlyTruthgazed = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Truthseeker").map((key) => state.board.get(key)!.instanceId);
    const newlyChargePulsed = newlyFlipped.filter((key) => state.board.get(key)!.cardId === "Skysplitter").map((key) => state.board.get(key)!.instanceId);
    // Mirror Pool only -- did any card that just became face-up (flip or rise)
    // complete a matching mirrored pair? Both sides must be face-up, same
    // hidden-info reasoning as hasMirrorTypeMatch's own per-card badge below --
    // a still-hidden mirror's identity shouldn't drive this either. Only ever
    // needs to check `justRevealed` cards as the trigger (a match can't newly
    // appear without one side of it just having flipped).
    const newlyRevealedPoolMatch =
      state.config.centerEffect === "mirrorPool" &&
      justRevealed.some((key) => {
        const c = state.board.get(key)!;
        if (!c.faceUp) return false;
        const p = parsePosKey(key);
        const mirrorP = { x: p.x, y: 2 * state.config.boardBounds.center.y - p.y };
        if (mirrorP.y === p.y) return false;
        const mirrorC = state.board.get(posKey(mirrorP));
        return !!mirrorC && mirrorC.faceUp && mirrorC.cardId === c.cardId;
      })
        ? ["pool"]
        : [];
    // Contested Lands (frontier) only -- did any card just placed this render end
    // up adjacent to an opposing player's card? Ownership (unlike identity) is
    // always public regardless of face state, so this checks every newly placed
    // card's neighbors regardless of whether either side is face-up -- no
    // hidden-info concern, matching the location's own "+1 per distinct opposing
    // neighbor" rule, which also doesn't care about face state.
    const newlyContestedGlow =
      state.config.centerEffect === "frontier" &&
      newlyPlaced.some((key) => {
        const c = state.board.get(key)!;
        return getAdjacentCards(state.board, state.config.boardBounds, parsePosKey(key)).some((n) => n.ownerId !== c.ownerId);
      })
        ? ["ruin"]
        : [];
    // No Man's Land (Trench) only -- spin each corner's own cannon once its own
    // quadrant (split by the center row/column) is completely filled. Same
    // "compare against the ref's last answer, only on a genuine placement" shape
    // as the Outpost above, just once per corner instead of once total.
    if (state.config.centerEffect === "noMansLand" && newlyPlaced.length > 0) {
      const { width: bw, height: bh, center } = state.config.boardBounds;
      // Each quadrant is bordered BY the cross (so it stops one short of
      // center.x/center.y, exclusive) but otherwise runs all the way out to the
      // board's own edge, INCLUSIVE -- the corner tile itself is the only cell
      // excluded (it's the ownerless Trench tile, never a real board cell, so
      // including it in the fullness check would make quadrantFull permanently
      // false). An earlier version also excluded the whole edge row/column
      // bordering that corner (starting the loop at xRange[0]+1/yRange[0]+1),
      // which checked only the quadrant's own inner half -- triggering the spin
      // once that smaller sub-area filled, well before the real quadrant was.
      const corners: { id: string; xs: number[]; ys: number[]; corner: Position }[] = [
        { id: "tl", xs: range(0, center.x - 1), ys: range(0, center.y - 1), corner: { x: 0, y: 0 } },
        { id: "tr", xs: range(center.x + 1, bw - 1), ys: range(0, center.y - 1), corner: { x: bw - 1, y: 0 } },
        { id: "bl", xs: range(0, center.x - 1), ys: range(center.y + 1, bh - 1), corner: { x: 0, y: bh - 1 } },
        { id: "br", xs: range(center.x + 1, bw - 1), ys: range(center.y + 1, bh - 1), corner: { x: bw - 1, y: bh - 1 } },
      ];
      const newlyToSpin: string[] = [];
      for (const { id, xs, ys, corner } of corners) {
        if (prevQuadrantFullRef.current[id]) continue;
        const quadrantCells: Position[] = [];
        for (const x of xs) for (const y of ys) if (x !== corner.x || y !== corner.y) quadrantCells.push({ x, y });
        const quadrantFull = quadrantCells.length > 0 && quadrantCells.every((p) => state.board.has(posKey(p)));
        if (quadrantFull) newlyToSpin.push(id);
        prevQuadrantFullRef.current[id] = quadrantFull;
      }
      if (newlyToSpin.length > 0) setTrenchSpinCorners((current) => new Set([...current, ...newlyToSpin]));
    }
    // flipDisruptionTargets/flipBoostTargets don't themselves care whether a target
    // is face-up (the real scoring math doesn't either -- e.g. Earthshaker hits
    // every card in its row/col, Pretender's own penalty applies from a hidden
    // neighbor just as much as a visible one). Most disruptors are "blanket": which
    // cells get hit is determined purely by POSITION (row/col, adjacency), so
    // flashing red on a hidden target reveals nothing about its identity that
    // wasn't already obvious from the board layout alone -- Earthshaker's targets in
    // particular should flash (wobble included) even face-down, since every card in
    // its row/col genuinely gets hit and hiding that would just look like a bug.
    // PlagueBearer/Noctule is the one exception: which specific neighbors get hit
    // depends on hidden IDENTITY (do two neighbors happen to match types), so its
    // targets get their own special-cased, visible-only recomputation below instead
    // of trusting flipDisruptionTargets' real-board answer directly.
    const visiblePlagueBearerTargets = (pos: Position): string[] => {
      const groups = new Map<CardId, string[]>();
      for (const n of getAdjacentCards(state.board, state.config.boardBounds, pos)) {
        if (!n.faceUp) continue;
        const list = groups.get(n.cardId);
        if (list) list.push(n.instanceId);
        else groups.set(n.cardId, [n.instanceId]);
      }
      return [...groups.values()].filter((group) => group.length >= 2).flat();
    };
    const newlyDisrupted = justRevealed.flatMap((key) => {
      const card = state.board.get(key)!;
      const pos = parsePosKey(key);
      return card.cardId === "PlagueBearer"
        ? visiblePlagueBearerTargets(pos)
        : flipDisruptionTargets(state.board, state.config.boardBounds, state.round, pos, card);
    });
    // Earthshaker only -- its own disruption targets get the red flash PLUS a
    // wobble (see .card-earthshake-wobble in globals.css, rendered INSTEAD of the
    // plain .card-disrupted every other disruptor's targets get -- two classes
    // each setting their own `animation` shorthand on one element don't compose),
    // since a literal earthquake should shake the ground it hits harder than a
    // generic debuff. Every card in its row/col, hidden or not.
    const newlyEarthshaken = justRevealed
      .filter((key) => state.board.get(key)!.cardId === "Earthshaker")
      .flatMap((key) => {
        const card = state.board.get(key)!;
        return flipDisruptionTargets(state.board, state.config.boardBounds, state.round, parsePosKey(key), card);
      });
    // flipBoostTargets deliberately includes a card's own self-boost (see its own
    // doc comment), unlike flipDisruptionTargets which excludes self entirely --
    // for most self-boosters that's harmless (Footman's line bonus depends only on
    // ownership, which is always public; Gloryseeker's depends only on its own face
    // state), but three specifically depend on ANOTHER card's identity somewhere
    // else on the board: Commander/Hipparch (an adjacent Footman), Berserker/Hydra
    // (an enemy Berserker anywhere on the board), and PlagueBearer/Noctule (2+
    // matching-type neighbors). The real math doesn't care if that other card is
    // face-up, but glowing green here whenever the condition holds would leak that
    // a still-hidden qualifying card exists -- so for just these three, recompute
    // the same condition using only currently-visible (face-up) cards before
    // deciding whether the self-boost still gets to flash.
    const isSelfBoostVisible = (card: CardInstance, pos: Position): boolean => {
      if (card.cardId === "Commander") {
        return getAdjacentCards(state.board, state.config.boardBounds, pos).some((n) => n.faceUp && n.cardId === "Footman");
      }
      if (card.cardId === "Berserker") {
        // Any other face-up Berserker now counts, own copies included -- see
        // cards.ts's own rework (no more unique-enemy-owner dedup).
        return [...state.board.values()].some((c) => c.faceUp && c.cardId === "Berserker" && c.instanceId !== card.instanceId);
      }
      if (card.cardId === "PlagueBearer") {
        const counts = new Map<CardId, number>();
        for (const n of getAdjacentCards(state.board, state.config.boardBounds, pos)) {
          if (!n.faceUp) continue;
          counts.set(n.cardId, (counts.get(n.cardId) ?? 0) + 1);
        }
        return [...counts.values()].some((count) => count >= 2);
      }
      return true;
    };
    const newlyBoosted = justRevealed.flatMap((key) => {
      const card = state.board.get(key)!;
      const pos = parsePosKey(key);
      const targets = flipBoostTargets(state.board, state.config.boardBounds, state.round, pos, card);
      return isSelfBoostVisible(card, pos) ? targets : targets.filter((id) => id !== card.instanceId);
    });

    const cleanups = [
      flash(newlyFlippedIds, setFlippingIds, FLIP_ANIMATION_MS),
      flash(newlyRisenIds, setRisingIds, RISE_ANIMATION_MS),
      flash(newlyPawDropped, setPawDropIds, PAW_DROP_MS),
      flash(newlyPretenderSpin, setPretenderSpinIds, PRETENDER_SPIN_MS),
      flash(newlySlammed, setSlamIds, SLAM_MS),
      flash(newlyIgnited, setIgniteIds, IGNITE_MS),
      flash(newlySlid, setSlideIds, SLIDE_MS),
      flash(newlyHopped, setHopIds, HOP_MS),
      flash(newlyCharged, setChargeIds, CHARGE_MS),
      flash(newlyCoinFlipped, setCoinFlipIds, COIN_FLIP_MS),
      flash(newlyHydraSplit, setHydraIds, HYDRA_MS),
      flash(newlyPlagueScattered, setPlagueScatterIds, PLAGUE_SCATTER_MS),
      flash(newlyCrumbled, setCrumbleIds, CRUMBLE_MS),
      flash(newlyNoctuleFlownIn, setNoctuleFlyInIds, NOCTULE_FLY_IN_MS),
      flash(newlyHeraldRisen, setHeraldRiseIds, HERALD_RISE_MS),
      flash(newlySwordSwing, setSwordSwingIds, SWORD_SWING_MS),
      flash(newlyTruthgazed, setTruthgazeIds, TRUTHGAZE_MS),
      flash(newlyTrumpeted, setTrumpetIds, TRUMPET_MS),
      flash(newlyChargePulsed, setChargePulseIds, CHARGE_PULSE_MS),
      flash(newlyDisrupted, setDisruptedIds, DISRUPTION_FLASH_MS),
      flash(newlyEarthshaken, setEarthshakenIds, DISRUPTION_FLASH_MS),
      flash(newlyBoosted, setBoostedIds, DISRUPTION_FLASH_MS),
    ];
    // poolGlowEpoch/ruinGlowEpoch deliberately do NOT go through the shared
    // `flash` helper/cleanups array above, for two separate reasons found the
    // hard way:
    // 1. That cleanup cancels EVERY pending timer whenever this whole effect
    //    re-runs for ANY reason (any other card flipping/placing elsewhere on
    //    the board), not just the specific flash that scheduled it. Harmless for
    //    the many per-instanceId sets above (a stray cancelled removal just
    //    leaves one already-animated-out card's id orphaned in its own set, with
    //    no visible effect since the CSS animation's own `forwards` fill already
    //    holds its settled/off state regardless) -- but a single shared sentinel
    //    id ("pool"/"ruin") getting permanently orphaned blocks every future
    //    glow from ever being added again, since the id is already "in" the set
    //    and React sees no change.
    // 2. Even with dedicated timers (fixing #1), retriggering *while a previous
    //    glow is still visually playing* produced an identical className string
    //    both before and after ("pool-glow" -> "pool-glow"), which neither React
    //    nor the browser treats as a change -- the DOM class attribute never
    //    actually gets touched, so the CSS animation just keeps playing its
    //    original cycle instead of restarting. An incrementing epoch used as a
    //    React `key` (see the glow overlay below) forces a fresh DOM node on
    //    every genuine trigger, which reliably restarts the animation regardless
    //    of timing overlap with a previous one.
    if (newlyRevealedPoolMatch.length > 0) {
      if (poolGlowTimerRef.current) clearTimeout(poolGlowTimerRef.current);
      setPoolGlowEpoch((e) => e + 1);
      poolGlowTimerRef.current = setTimeout(() => setPoolGlowEpoch(0), POOL_GLOW_MS);
    }
    if (newlyContestedGlow.length > 0) {
      if (ruinGlowTimerRef.current) clearTimeout(ruinGlowTimerRef.current);
      setRuinGlowEpoch((e) => e + 1);
      ruinGlowTimerRef.current = setTimeout(() => setRuinGlowEpoch(0), RUIN_GLOW_MS);
    }
    return () => {
      for (const cleanup of cleanups) cleanup?.();
    };
  }, [state.board, state.config.boardBounds, state.round]);

  // Genuine unmount-only cleanup for poolGlowTimerRef/ruinGlowTimerRef (see
  // above) -- separate from the main effect since those timers deliberately
  // outlive any single run of it.
  useEffect(() => {
    return () => {
      if (poolGlowTimerRef.current) clearTimeout(poolGlowTimerRef.current);
      if (ruinGlowTimerRef.current) clearTimeout(ruinGlowTimerRef.current);
      if (outpostGlowTimerRef.current) clearTimeout(outpostGlowTimerRef.current);
      if (outpostCollapseTimerRef.current) clearTimeout(outpostCollapseTimerRef.current);
    };
  }, []);

  // The Frontier (borderlands)'s Outpost -- its own effect, deliberately NOT folded
  // into the main flip/place-detection effect above: that one only ever runs its
  // body past an early-return guard requiring a genuine flip or placement
  // (justRevealed/newlyPlaced), so a pure removal (sandbox's remove-a-card mode)
  // never reached this logic at all -- the Outpost would stay permanently
  // collapsed even after the edge that completed it was broken back open, with no
  // way to re-test the crumble without starting a whole new game. Recomputing
  // "is the edge full" fresh on every board change (add OR remove) instead makes
  // this naturally reversible: removing an edge card immediately pops the Outpost
  // back (no reverse animation, it just wasn't there a moment ago either), and
  // refilling the edge again re-triggers the same crumble.
  useEffect(() => {
    if (state.config.centerEffect !== "borderlands") return;
    const { width: bw, height: bh } = state.config.boardBounds;
    const onEdge = (p: Position) => p.x === 0 || p.y === 0 || p.x === bw - 1 || p.y === bh - 1;
    const edgePositions: Position[] = [];
    for (let x = 0; x < bw; x++)
      for (let y = 0; y < bh; y++) if (onEdge({ x, y })) edgePositions.push({ x, y });
    const occupiedCount = edgePositions.filter((p) => state.board.has(posKey(p))).length;
    const edgeFullNow = occupiedCount === edgePositions.length;
    const prevOccupiedCount = prevEdgeOccupiedCountRef.current;
    prevEdgeOccupiedCountRef.current = occupiedCount;

    if (edgeFullNow && !prevEdgeFullRef.current) {
      if (outpostGlowTimerRef.current) clearTimeout(outpostGlowTimerRef.current);
      setOutpostGlowEpoch(0);
      setOutpostCrumbling(true);
      if (outpostCollapseTimerRef.current) clearTimeout(outpostCollapseTimerRef.current);
      outpostCollapseTimerRef.current = setTimeout(() => {
        setOutpostCrumbling(false);
        setOutpostCollapsed(true);
      }, CRUMBLE_MS);
    } else if (!edgeFullNow) {
      if (outpostCollapsed || outpostCrumbling) {
        if (outpostCollapseTimerRef.current) clearTimeout(outpostCollapseTimerRef.current);
        setOutpostCrumbling(false);
        setOutpostCollapsed(false);
      }
      if (occupiedCount > prevOccupiedCount) {
        if (outpostGlowTimerRef.current) clearTimeout(outpostGlowTimerRef.current);
        setOutpostGlowEpoch((e) => e + 1);
        outpostGlowTimerRef.current = setTimeout(() => setOutpostGlowEpoch(0), OUTPOST_GLOW_MS);
      }
    }
    prevEdgeFullRef.current = edgeFullNow;
  }, [state.board, state.config.boardBounds, state.config.centerEffect, outpostCollapsed, outpostCrumbling]);

  // No Man's Land (Trench) -- same reasoning as the Outpost's own dedicated effect
  // above: glow every Trench tile whenever a card lands on the center's row/column
  // (the "cross" -- see noMansLand's valueModifiers), on its own so a removal
  // doesn't matter here either (nothing to revert -- this is a plain one-shot
  // flash, not a permanent collapse).
  const prevCrossOccupiedCountRef = useRef(0);
  useEffect(() => {
    if (state.config.centerEffect !== "noMansLand") return;
    const { center } = state.config.boardBounds;
    const onCross = (p: Position) => p.x === center.x || p.y === center.y;
    let occupiedCount = 0;
    for (const key of state.board.keys()) if (onCross(parsePosKey(key))) occupiedCount++;
    const prevOccupiedCount = prevCrossOccupiedCountRef.current;
    prevCrossOccupiedCountRef.current = occupiedCount;
    if (occupiedCount > prevOccupiedCount) {
      if (trenchGlowTimerRef.current) clearTimeout(trenchGlowTimerRef.current);
      setTrenchGlowEpoch((e) => e + 1);
      trenchGlowTimerRef.current = setTimeout(() => setTrenchGlowEpoch(0), OUTPOST_GLOW_MS);
    }
  }, [state.board, state.config.boardBounds, state.config.centerEffect]);

  useEffect(() => {
    return () => {
      if (trenchGlowTimerRef.current) clearTimeout(trenchGlowTimerRef.current);
    };
  }, []);

  // Cells are sized to fill their grid column (aspect-square, no fixed px) rather than
  // a fixed h-20 w-20 -- with wider/taller boards (7-8p can be 11+ columns or rows) a
  // fixed cell size would push the grid past the available width or height. Rows are
  // implicit and auto-sized purely off each cell's own rendered width (aspect-square),
  // so the grid's total footprint is entirely determined by ITS width -- there's no
  // separate row-height constraint to satisfy. That means the whole "fit both
  // dimensions" problem reduces to picking one width, which we compute directly as the
  // smallest of: the available horizontal space (100%), a comfortable 5rem/cell cap,
  // and whatever width keeps the resulting height (at 5rem/cell) within a viewport
  // budget. Setting `width` (not `max-width`) to that precomputed value means there's
  // nothing left for the browser to reflow or overflow -- unlike relying on `aspect-
  // ratio` + `max-height` to shrink an already-definite `width: 100%`, which it won't.
  const CELL_SIZE_PX = 80;
  const GAP_PX = 6;
  const VERTICAL_BUDGET_VH = 90;
  const naturalWidthPx = width * CELL_SIZE_PX + (width - 1) * GAP_PX;
  // `svh` (small viewport height), not `vh` -- `vh` tracks the browser's live visible
  // viewport, which shrinks/grows as mobile browser chrome (address bar) collapses or
  // expands during scrolling/interaction. For a near-square board (8p is ~11x11) this
  // height budget is almost always the binding constraint, so a plain `vh` here meant
  // the board visibly resized mid-game any time the toolbar changed. `svh` always
  // assumes the toolbar is visible (the smallest possible viewport), so it's stable.
  const widthForHeightBudget = `calc(${VERTICAL_BUDGET_VH}svh * ${width / height})`;

  // Computed once per render (not per-cell) -- see computePlagueInfection's own doc
  // comment for why this is safe to call live, against the CURRENT board, to drive
  // the top-left "infected" badge below.
  const negatedInstanceIds = computeNegatedInstanceIds(state.board, state.config.boardBounds);
  const plagueInfection = computePlagueInfection(state.board, state.config.boardBounds, negatedInstanceIds, true);

  // World-Tree (the "none" location -- see its own label in centerEffects.ts) only --
  // its icon starts small and grows a fixed amount each ROUND (not continuously as
  // cards get placed), so it advances in discrete steps in step with the round
  // counter rather than ticking up with every individual placement.
  const worldTreeScale = 0.55 + 0.60 * Math.min(1, state.round / state.config.roundCap);

  return (
    <div
      className={`relative grid gap-1.5 rounded-xl p-1.5 ${turnHighlighted ? "turn-glow" : ""}`}
      style={{
        gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))`,
        width: `min(100%, ${naturalWidthPx}px, ${widthForHeightBudget})`,
      }}
    >
      {state.config.centerEffect === "mirrorPool" && (
        // Marks the mirror axis itself (the center row -- see mirrorPool's
        // valueModifiers: a card's mirror is the same column, reflected across this
        // row, and a card ON this row has no distinct mirror at all) with a thin
        // dashed line through its vertical midpoint. Every row is the same height
        // (uniform aspect-square cells), so that midpoint is just this row's index
        // as a fraction of the total row count, no pixel measurement needed.
        <div
          className={`pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-current opacity-70 ${CENTER_EFFECTS.mirrorPool.themeColorClass}`}
          style={{ top: `${((state.config.boardBounds.center.y + 0.5) / height) * 100}%` }}
        />
      )}
      {rows.map((y) =>
        cols.map((x) => {
          const pos = { x, y };
          if (!inBounds(pos, state.config.boardBounds)) return null;
          const key = posKey(pos);
          const isOwnerless = isOwnerlessPosition(pos, state.config.boardBounds);
          const card = state.board.get(key);
          const isLegal = forceAllClickable || legalCellKeys.has(key);
          // No Man's Land's -2 hits every card on the center's row AND column (see
          // noMansLand's valueModifiers) -- a plain grey wash over every cell in that
          // cross (occupied or not) makes the debuffed zone visible at a glance,
          // instead of only discovering it card by card via a breakdown popup.
          const inNoMansLandCross =
            state.config.centerEffect === "noMansLand" &&
            (pos.x === state.config.boardBounds.center.x || pos.y === state.config.boardBounds.center.y);
          // Corpse of the Great Wyrm's +1 always lands on any card adjacent to any of
          // the 3 heads (see threeHeadedDragon's valueModifiers) -- a static zone,
          // purely positional (known before anything is even placed), so a light wash
          // in the location's own theme color highlights it the same way No Man's
          // Land's grey wash marks its debuff zone, just for a buff instead.
          const inWyrmHeadZone =
            state.config.centerEffect === "threeHeadedDragon" &&
            (state.config.boardBounds.ownerless ?? [state.config.boardBounds.center]).some(
              (h) => Math.abs(h.x - pos.x) + Math.abs(h.y - pos.y) === 1
            );
          // The Frontier's edge/corner bonus (see borderlands' valueModifiers) is
          // purely positional -- a light wash marks the +1 edge, a stronger one marks
          // the +2 corners, visible before anything is even placed.
          const { width: boardWidth, height: boardHeight } = state.config.boardBounds;
          const onFrontierEdge =
            state.config.centerEffect === "borderlands" &&
            (pos.x === 0 || pos.y === 0 || pos.x === boardWidth - 1 || pos.y === boardHeight - 1);
          const onFrontierCorner =
            onFrontierEdge && (pos.x === 0 || pos.x === boardWidth - 1) && (pos.y === 0 || pos.y === boardHeight - 1);
          // An inset box-shadow, not a separate absolutely-positioned overlay div --
          // painted directly on each cell's own bordered/rounded box (whichever
          // element that is per branch below), so it's pixel-identical to that box no
          // matter how its own wrapper happens to be sized, instead of relying on a
          // sibling `inset-0` div to independently end up the same size.
          const effectHighlightClass = inNoMansLandCross
            ? "shadow-[inset_0_0_0_9999px_rgba(113,113,122,0.1)]"
            : inWyrmHeadZone
              ? "shadow-[inset_0_0_0_9999px_rgba(192,38,211,0.06)]"
              : onFrontierCorner
                ? "shadow-[inset_0_0_0_9999px_rgba(56,145,197,0.28)]"
                : onFrontierEdge
                  ? "shadow-[inset_0_0_0_9999px_rgba(56,145,197,0.14)]"
                  : "";

          if (isOwnerless) {
            const effect = CENTER_EFFECTS[state.config.centerEffect];
            const label = effect.ownerlessLabel ?? effect.label;
            const detail = centerEffectDescription(state.config.centerEffect, state.config);
            // Which half-art variant (if any) applies to THIS specific ownerless
            // tile, based purely on its position relative to center -- see
            // hasLeftLocationArt/hasRightLocationArt above.
            const sideOfCenter = pos.x < state.config.boardBounds.center.x ? "left" : pos.x > state.config.boardBounds.center.x ? "right" : undefined;
            const artVariant =
              (sideOfCenter === "left" && hasLeftLocationArt) || (sideOfCenter === "right" && hasRightLocationArt)
                ? sideOfCenter
                : undefined;
            // The Frontier (borderlands) only -- once the board's edge is completely
            // full the Outpost has permanently crumbled (see outpostCollapsed's own
            // doc comment above) -- the tile shows nothing at all from then on,
            // overriding hasArtForThisTile entirely rather than falling back to the
            // plain solid-square fallback every other art-less location gets.
            const isOutpostCollapsed = state.config.centerEffect === "borderlands" && outpostCollapsed;
            // Hides the real icon for the whole crumble, not just once it's fully
            // collapsed -- otherwise the real icon sits there fully visible
            // underneath the falling pieces (which only fade out from full opacity
            // themselves) for the whole ~650ms, reading as "the icon never actually
            // left." Same "hide the real icon outright, don't just dim it" idea as
            // Facestealer/Infiltrator's own card crumble.
            const hideOutpostIcon = state.config.centerEffect === "borderlands" && (outpostCrumbling || outpostCollapsed);
            const hasArtForThisTile = !hideOutpostIcon && (artVariant !== undefined || hasLocationArt);
            // No Man's Land (Trench) only -- which corner (if any) this specific
            // ownerless tile is, matching the same 4 positions ownerlessPositions
            // itself returns -- drives trenchSpinCorners' one-shot rotateY spin
            // below.
            const trenchCornerId =
              state.config.centerEffect === "noMansLand"
                ? pos.x === 0 && pos.y === 0
                  ? "tl"
                  : pos.x === state.config.boardBounds.width - 1 && pos.y === 0
                    ? "tr"
                    : pos.x === 0 && pos.y === state.config.boardBounds.height - 1
                      ? "bl"
                      : pos.x === state.config.boardBounds.width - 1 && pos.y === state.config.boardBounds.height - 1
                        ? "br"
                        : undefined
                : undefined;
            const trenchSpinClass = trenchCornerId && trenchSpinCorners.has(trenchCornerId) ? "trench-cannon-flip" : "";
            // Hall of Fortunes (reckoning) only -- which of this player's 3
            // offered cards (if any) THIS specific Pillar tile is currently
            // standing in for, purely by x position relative to center (matching
            // reckoning's own ownerlessPositions: x-2/x/x+2 -- left-to-right is
            // slot 0/1/2). Only set while hofPhase is active, so a Pillar tile
            // renders completely normally the rest of the time.
            const hofSlot =
              state.config.centerEffect === "reckoning" && hofPhase !== "idle"
                ? pos.x < state.config.boardBounds.center.x
                  ? 0
                  : pos.x > state.config.boardBounds.center.x
                    ? 2
                    : 1
                : -1;
            const hofCard = hofSlot >= 0 ? hofDisplayCards[hofSlot] : undefined;
            const hofDef = hofCard ? CARD_DEFS[hofCard.cardId] : undefined;
            // The Pit of Erebus (shadowlands) only -- its own moon icon turns red
            // once flips actually unlock (they're delayed an extra round here, see
            // flipGate in centerEffects.ts), as a visual cue that the location's
            // own hold has lifted. Live/per-render off isFlipUnlocked, the same
            // shared check turns.ts uses to decide real flip legality, not a
            // hand-rolled copy of its round math. (An earlier version used a CSS
            // `invert` filter instead -- on this location's own indigo theme
            // color, that inverted to a yellow-green rather than anything
            // meaningful, so this sets the color directly instead.)
            const isErebusFlipUnlocked = state.config.centerEffect === "shadowlands" && isFlipUnlocked(state.round, state.config);
            // Corpse of the Great Wyrm (threeHeadedDragon) only -- turns THIS
            // specific head a pale bone-grey once every one of its own orthogonal neighbors is
            // occupied (a real card, or another ownerless tile -- same "boxed in"
            // definition Giant Bear's own tile-color check below uses), not just
            // whenever any head anywhere is surrounded. Purely positional/occupancy
            // -- never depends on a neighbor's hidden identity, so no leak concern.
            const isHeadSurrounded =
              state.config.centerEffect === "threeHeadedDragon" &&
              !adjacentPositions(pos, state.config.boardBounds).some(
                (p) => !isOwnerlessPosition(p, state.config.boardBounds) && !state.board.has(posKey(p))
              );
            // Free Cities only -- recolors THIS specific City tile once every one of
            // its own orthogonal neighbors is occupied, same "boxed in" definition as
            // Corpse of the Great Wyrm's own per-head check above (Free Cities can
            // have multiple City tiles -- each is checked independently).
            const isCitySurrounded =
              state.config.centerEffect === "freeCities" &&
              !adjacentPositions(pos, state.config.boardBounds).some(
                (p) => !isOwnerlessPosition(p, state.config.boardBounds) && !state.board.has(posKey(p))
              );
            const locationThemeColorClass = isHeadSurrounded
              ? "text-stone-300 dark:text-stone-400"
              : isCitySurrounded
                ? "text-amber-900 dark:text-amber-700"
                : isErebusFlipUnlocked
                  ? "text-red-600 dark:text-red-500"
                  : effect.themeColorClass;
            // Always the flat base value, never the live computed one -- some of its
            // adjacency modifiers (Bannerman's, notably) don't require face-up, so
            // showing the true live value would leak a face-down card's identity
            // before anyone actually flips it. The real end-of-game math is untouched
            // (see kingslayer's postResolution in centerEffects.ts) -- this is a
            // display-only simplification.
            const displayLabel = state.config.centerEffect === "kingslayer" ? `${label} (${KINGSLAYER_BASE_VALUE})` : label;
            // Only exists once the game has ended (see resolvedCards' own doc comment)
            // and only for Kingslayer, which is the only location whose center itself
            // has a real value/breakdown to show -- see its postResolution hook in
            // centerEffects.ts.
            const kingslayerCard = resolvedCards?.get(KINGSLAYER_INSTANCE_ID);
            const tooltipId = `board:${key}`;
            return (
              <div
                key={key}
                className="relative @container"
                // Hover-capable devices get real hover; touch devices get an explicit
                // tap-to-toggle instead -- never both (see useHasHover's doc comment
                // for why mixing them needs two taps on touch to ever show anything).
                // setActiveTooltip/toggleActiveTooltip (not local state) so this
                // shares one "only one tooltip open at a time, anywhere in the app"
                // source of truth with every other tap-to-toggle tooltip -- see
                // activeTooltip.ts's doc comment.
                onMouseEnter={
                  hasHover
                    ? (e) => {
                        setActiveRect(e.currentTarget.getBoundingClientRect());
                        setActiveTooltip(tooltipId);
                      }
                    : undefined
                }
                onMouseLeave={hasHover ? () => clearActiveTooltip(tooltipId) : undefined}
                onClick={
                  hasHover
                    ? undefined
                    : (e) => {
                        e.stopPropagation();
                        setActiveRect(e.currentTarget.getBoundingClientRect());
                        toggleActiveTooltip(tooltipId);
                      }
                }
              >
                {/* Below the threshold, the label can't fit without wrapping (which,
                    combined with the aspect-square cell, either overflows or looks
                    like a mangled two-line squeeze) -- so it's just a solid tinted
                    block instead, no text. Same idea as the card name's own
                    @container cutoff, just a different fallback since this tile has
                    no icon to fall back to -- unless the location has one (see
                    hasLocationArt above), in which case both size variants below show
                    that icon instead of their plain fallback. 70px (not the card
                    name's own 72px, close but tuned separately) -- an 8p board's
                    cells landed just above a lower 52px threshold, wide enough to
                    switch into text mode but still too cramped for most location
                    labels, cutting them off; 70px pushes 8p back into the plain
                    fallback while a 4p board's much bigger cells stay comfortably
                    in text mode. */}
                {!isOutpostCollapsed && !hofCard && (
                  <div
                    className={`hidden aspect-square w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border-2 border-dashed border-zinc-400 p-1 text-center text-[9px] leading-tight break-words text-zinc-400 @[70px]:flex ${effectHighlightClass}`}
                  >
                    {hasArtForThisTile && (
                      <LocationArt
                        id={state.config.centerEffect}
                        variant={artVariant}
                        className={`${BOLD_LOCATION_ART_IDS.has(state.config.centerEffect) ? "h-3/4 w-3/4" : "h-1/2 w-1/2"} shrink-0 ${locationThemeColorClass} ${trenchSpinClass}`}
                        style={state.config.centerEffect === "none" ? { transform: `scale(${worldTreeScale})` } : undefined}
                      />
                    )}
                    <span className="truncate">{displayLabel}</span>
                  </div>
                )}
                {!isOutpostCollapsed &&
                  !hofCard &&
                  (hasArtForThisTile ? (
                    <LocationArt
                      id={state.config.centerEffect}
                      variant={artVariant}
                      className={`aspect-square w-full rounded-md ${BOLD_LOCATION_ART_IDS.has(state.config.centerEffect) ? "" : "opacity-60"} @[70px]:hidden ${locationThemeColorClass} ${effectHighlightClass} ${trenchSpinClass}`}
                      style={state.config.centerEffect === "none" ? { transform: `scale(${worldTreeScale})` } : undefined}
                    />
                  ) : (
                    <div className={`aspect-square w-full rounded-md opacity-60 @[70px]:hidden ${locationThemeColorClass} bg-current ${effectHighlightClass}`} />
                  ))}
                {hofCard && hofDef && (
                  // Hall of Fortunes only -- this specific Pillar tile is
                  // standing in for one of the viewer's own 3 freshly-offered
                  // cards (see hofSlot above): it spins in place through
                  // hofPhase's own "spinning" window, then the Pillar face
                  // fades out while the real card's icon/name/value fades in
                  // underneath it at the same time (same cross-fade shape as
                  // Outpost's crumble-then-empty transition, just revealing
                  // instead of emptying), holds briefly, then hofPhase returns
                  // to "idle" and this whole block stops rendering, letting the
                  // tile fall back to its plain Pillar art above.
                  <div className="@container absolute inset-0 z-20 aspect-square w-full overflow-hidden rounded-md border-2 border-dashed border-zinc-400 bg-white/85 p-1 dark:bg-zinc-950/85">
                    <div
                      className={`absolute inset-0 flex flex-col items-center justify-center gap-0.5 p-1 ${CENTER_EFFECTS.reckoning.themeColorClass} ${
                        hofPhase === "revealed" ? "hof-reveal-fade-out" : "hof-pillar-spin"
                      }`}
                    >
                      <LocationArt id="reckoning" className="h-3/4 w-3/4 shrink-0" />
                    </div>
                    <div
                      className={`absolute inset-0 flex flex-col items-center justify-center gap-0.5 p-1 text-center opacity-0 ${
                        hofPhase === "revealed" ? "hof-reveal-fade-in" : ""
                      }`}
                    >
                      <span className="hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight font-semibold @[48px]:block">
                        {hofDef.name}
                      </span>
                      <CardArt cardId={hofCard.cardId} className="h-1/2 w-1/2 shrink-0" />
                      <span className="text-[length:clamp(9px,26cqw,15px)] leading-none font-bold">{hofDef.base}</span>
                    </div>
                  </div>
                )}
                {outpostCrumbling && (
                  // The Frontier (borderlands) only -- the Outpost's own icon
                  // cracks into four falling quadrant pieces (same real-
                  // LocationArt-copy technique as Facestealer/Infiltrator's own
                  // card-icon crumble) the instant the board's edge is completely
                  // filled, then the tile stays permanently empty (see
                  // isOutpostCollapsed above) once outpostCollapsed flips true.
                  <div className="pointer-events-none absolute inset-0 z-20">
                    <LocationArt id={state.config.centerEffect} variant={artVariant} className={`absolute inset-0 card-icon-crumble-piece-1 ${locationThemeColorClass}`} />
                    <LocationArt id={state.config.centerEffect} variant={artVariant} className={`absolute inset-0 card-icon-crumble-piece-2 ${locationThemeColorClass}`} />
                    <LocationArt id={state.config.centerEffect} variant={artVariant} className={`absolute inset-0 card-icon-crumble-piece-3 ${locationThemeColorClass}`} />
                    <LocationArt id={state.config.centerEffect} variant={artVariant} className={`absolute inset-0 card-icon-crumble-piece-4 ${locationThemeColorClass}`} />
                  </div>
                )}
                {poolGlowEpoch > 0 && (
                  // Mirror Pool only -- keyed by the epoch (see poolGlowEpoch's
                  // own doc comment above) so retriggering while a previous glow
                  // is still visible forces a genuinely fresh DOM node instead of
                  // reusing one whose className string hasn't changed, which
                  // would otherwise silently fail to restart the animation. A
                  // separate overlay sibling (not a class on the tile boxes
                  // above) specifically so it CAN be freely remounted without
                  // affecting the tile's own icon/label content.
                  <div key={poolGlowEpoch} className="pool-glow pointer-events-none absolute inset-0 rounded-md" />
                )}
                {ruinGlowEpoch > 0 && (
                  // Contested Lands only -- same remount-to-restart reasoning as
                  // Mirror Pool's own glow overlay above.
                  <div key={ruinGlowEpoch} className="ruin-glow pointer-events-none absolute inset-0 rounded-md" />
                )}
                {outpostGlowEpoch > 0 && (
                  // The Frontier (borderlands) only -- same remount-to-restart
                  // reasoning as Mirror Pool/Contested Lands' own glow overlays
                  // above.
                  <div key={outpostGlowEpoch} className="outpost-glow pointer-events-none absolute inset-0 rounded-md" />
                )}
                {trenchGlowEpoch > 0 && (
                  // No Man's Land only -- every Trench tile flashes together, same
                  // remount-to-restart reasoning as the other glow overlays above.
                  <div key={trenchGlowEpoch} className="trench-glow pointer-events-none absolute inset-0 rounded-md" />
                )}
                {activeTooltipId === tooltipId && activeRect && (
                  <FixedTooltip rect={activeRect}>
                    {/* The location's own full name (e.g. "Lazaret"), not the tile's
                        own short ownerlessLabel (e.g. "Ward") that's shown ON the
                        tile itself -- the tile stays a compact positional label, but
                        the hover is explaining the whole location's rule, so it
                        should read by the location's actual name. */}
                    {effect.label} — {detail}
                    {kingslayerHit && kingslayerHit.length > 0 && (
                      <div className="mt-1">
                        Hit:{" "}
                        {kingslayerHit
                          .map((id) => {
                            const hitCard = resolvedCards?.get(id);
                            return hitCard ? `${CARD_DEFS[hitCard.cardId].name} (${nameFor(hitCard.ownerId)})` : null;
                          })
                          .filter(Boolean)
                          .join(", ")}
                      </div>
                    )}
                    {kingslayerCard && (
                      <div className="mt-1 border-t border-white/20 pt-1 dark:border-black/20">
                        <BreakdownPopup breakdown={kingslayerCard.breakdown} finalValue={kingslayerCard.finalValue} />
                      </div>
                    )}
                  </FixedTooltip>
                )}
              </div>
            );
          }

          if (card) {
            const clickable = forceAllClickable || (!card.faceUp && flipTargetIds.has(card.instanceId) && !selectedInstanceId);
            const displayFaceUp = revealAll || card.faceUp;
            // At game end, cards that were face-down during play are shown with faded
            // text instead of a separate badge -- distinguishable without being loud.
            const faded = revealAll && !card.faceUp;
            // Negation (Suppressor/Lictor's 3+-adjacent rule) cancels a card's own
            // printed effect entirely -- greys its icon out to make that visible at a
            // glance, taking priority over every other tint below (a negated card's
            // "other copies"/"boosted" conditions may still be numerically true, but
            // none of them actually pay out while negated, so showing their normal
            // color would be misleading). Purely positional (Suppressor's own
            // 3+-neighbor gate), never a hidden identity, so always safe to show.
            const isNegated = negatedInstanceIds.has(card.instanceId);
            const def = CARD_DEFS[card.cardId];
            // Live, per-render indicators (recomputed off the current board every
            // render, not a one-shot flip flourish) for four cards whose own
            // ability is conditional -- tinting the icon whenever the condition is
            // CURRENTLY true, so it updates immediately as neighbors are placed/
            // removed, not just at the moment this card was flipped. This card
            // itself being face-up is never a hidden-info problem (renderFaceUpContent
            // is only ever called once it's genuinely revealed), but Usurper's/
            // Noctule's OWN conditions read a NEIGHBOR's identity/base -- the real
            // scoring rule (Pretender's valueModifier) doesn't care whether that
            // neighbor is face-up, but a live UI hint that lights up BECAUSE of a
            // still-hidden neighbor would leak partial information about that
            // neighbor (that its base happens to be >= this card's, or that it
            // matches another neighbor's type) before it's ever flipped -- so
            // those two checks only ever look at neighbors that are already
            // face-up (getAdjacentCards only ever returns real CardInstance
            // entries -- an ownerless tile isn't one, so it never needs its own
            // case here). Lictor's and Bear's own checks only ever need occupancy
            // (is there a card there at all, not what it is), which was never
            // hidden info, so they're unaffected.
            const isLictorActive =
              card.cardId === "Suppressor" &&
              (CARD_DEFS.Suppressor.negatesNeighborsIf?.({ board: state.board, bounds: state.config.boardBounds, pos }) ?? false);
            const isNoctuleActive =
              card.cardId === "PlagueBearer" &&
              (() => {
                const counts = new Map<CardId, number>();
                for (const n of getAdjacentCards(state.board, state.config.boardBounds, pos)) {
                  if (!n.faceUp) continue;
                  counts.set(n.cardId, (counts.get(n.cardId) ?? 0) + 1);
                }
                return [...counts.values()].some((count) => count >= 2);
              })();
            const isUsurperThreatened =
              card.cardId === "Pretender" &&
              getAdjacentCards(state.board, state.config.boardBounds, pos).some((n) => n.faceUp && CARD_DEFS[n.cardId].base >= def.base);
            const isBearBoxedIn =
              card.cardId === "Exile" &&
              !adjacentPositions(pos, state.config.boardBounds).some(
                (p) => !isOwnerlessPosition(p, state.config.boardBounds) && !state.board.has(posKey(p))
              );
            // Mirror Pool only -- a small badge in the card's own top-right corner
            // once its mirror position (same column, opposite side of the center
            // row -- see mirrorPool's valueModifiers) holds a card of the exact same
            // type, currently earning the location's own doubled "+2 each" bonus
            // instead of the plain "+1 each" any occupied mirror gets. Requires BOTH
            // this card and its mirror to be face-up -- a still-hidden card's
            // identity (whether it happens to match) is exactly the kind of thing
            // that shouldn't leak through a live badge before it's revealed, for
            // either side of the match.
            const mirrorPos = { x: pos.x, y: 2 * state.config.boardBounds.center.y - pos.y };
            const mirrorCard = state.board.get(posKey(mirrorPos));
            const hasMirrorTypeMatch =
              state.config.centerEffect === "mirrorPool" &&
              card.faceUp &&
              mirrorPos.y !== pos.y &&
              !!mirrorCard &&
              mirrorCard.faceUp &&
              mirrorCard.cardId === card.cardId;
            // Zeus-Born (Skysplitter) only -- +1 per round elapsed at scoring, with
            // no cap of its own, but the game itself can never run past
            // state.config.roundCap (a real, fully public, deterministic ceiling --
            // see shouldEndGame in game.ts), so once the round counter reaches it,
            // this card has already banked the largest bonus it's ever going to get.
            const isZeusBornMaxed = card.cardId === "Skysplitter" && state.round >= state.config.roundCap;
            // Dying God only -- same roundCap reasoning as Zeus-Born above, but for
            // its own -1-per-round-elapsed penalty: once the round counter can't go
            // any higher, its penalty has already hit the worst it's ever going to get.
            const isDyingGodMaxed = card.cardId === "DyingGod" && state.round >= state.config.roundCap;
            // Hipparch/Nightjar/Hydra/Conciliator only -- each has its own hard cap on
            // how big its bonus can possibly get, and turns green once the live bonus
            // has actually reached it. Hipparch/Nightjar's caps are just the physical
            // 4-neighbor limit; Hydra/Conciliator's are additionally capped by the
            // number of OTHER players actually in the game (can't have more unique
            // enemy owners than that). Hipparch's and Hydra's own underlying
            // conditions depend on a neighbor's/board-mate's IDENTITY, so (same
            // reasoning as isUsurperThreatened/isNoctuleActive above) those two only
            // ever count already-face-up cards, to avoid a hidden card's identity
            // leaking through a "maxed out" hint it can't yet honestly earn.
            // Nightjar's condition depends only on face STATE (always public) and
            // Conciliator's only on OWNERSHIP (also always public), so neither needs
            // that filtering.
            const isHipparchMaxed =
              card.cardId === "Commander" &&
              getAdjacentCards(state.board, state.config.boardBounds, pos).filter((n) => n.faceUp && n.cardId === "Footman").length >= 4;
            const isNightjarMaxed =
              card.cardId === "Beacon" &&
              adjacentPositions(pos, state.config.boardBounds).filter((p) => {
                const occupied = isOwnerlessPosition(p, state.config.boardBounds) || state.board.has(posKey(p));
                return occupied && isPositionFaceUp(state.board, state.config.boardBounds, p) === card.faceUp;
              }).length >= 4;
            const isConciliatorMaxed =
              card.cardId === "Mercenary" &&
              new Set(
                getAdjacentCards(state.board, state.config.boardBounds, pos)
                  .filter((n) => n.ownerId !== card.ownerId)
                  .map((n) => n.ownerId)
              ).size >= Math.min(4, state.players.length - 1);
            // Hydra (Berserker)/Warlord only -- how many OTHER face-up copies of the
            // same card (any owner, own included -- see cards.ts's rework dropping the
            // old unique-enemy-owner dedup) currently exist. Only ever counts
            // currently-face-up cards, same hidden-info reasoning as Hipparch's/
            // Hydra's own older "maxed" check above -- this depends on another card's
            // IDENTITY, so a still-hidden matching card must never leak through here.
            const otherFaceUpCopies = (cardId: CardId) =>
              [...state.board.values()].filter((c) => c.faceUp && c.cardId === cardId && c.instanceId !== card.instanceId).length;
            const isHydraOneOther = card.cardId === "Berserker" && otherFaceUpCopies("Berserker") === 1;
            const isHydraTwoPlusOther = card.cardId === "Berserker" && otherFaceUpCopies("Berserker") >= 2;
            const isWarlordOneOther = card.cardId === "Warlord" && otherFaceUpCopies("Warlord") === 1;
            const isWarlordTwoPlusOther = card.cardId === "Warlord" && otherFaceUpCopies("Warlord") >= 2;
            // Hoplite (Footman) only -- green if a same-owner unbroken line of 3+
            // already includes it (re-derives the exact rowRun/colRun check
            // Footman.valueModifier itself uses, purely occupancy/ownership-based, no
            // identity dependency); blue if boosted by an adjacent face-up Hornblower
            // (Bannerman buffs ANY adjacent Footman, not just its own owner's, but this
            // DOES depend on the neighbor's identity, so a still-hidden Bannerman must
            // never light this up). Green wins when both apply -- see the shared
            // activatedColorClass/bonusMaxedColorClass chains below, where green
            // (bonusMaxedColorClass) is concatenated after blue (activatedColorClass),
            // so it naturally wins the CSS cascade without needing its own ternary.
            const isHopliteBoosted =
              card.cardId === "Footman" &&
              getAdjacentCards(state.board, state.config.boardBounds, pos).some((n) => n.faceUp && n.cardId === "Bannerman");
            const footmanRun = (dx: number, dy: number): number => {
              let count = 0;
              let x = pos.x + dx;
              let y = pos.y + dy;
              while (true) {
                const c = state.board.get(posKey({ x, y }));
                if (!c || c.ownerId !== card.ownerId) break;
                count++;
                x += dx;
                y += dy;
              }
              return count;
            };
            const isHopliteRowOfThree =
              card.cardId === "Footman" && (1 + footmanRun(-1, 0) + footmanRun(1, 0) >= 3 || 1 + footmanRun(0, -1) + footmanRun(0, 1) >= 3);
            // Hornblower (Bannerman) only -- yellow if currently buffing an adjacent
            // same-owner face-up Hoplite. Ownership is always public, but identity
            // (Footman vs. anything else) is not, so a still-hidden same-owner
            // neighbor must never light this up.
            const isHornblowerBoostingOwnHoplite =
              card.cardId === "Bannerman" &&
              getAdjacentCards(state.board, state.config.boardBounds, pos).some(
                (n) => n.faceUp && n.cardId === "Footman" && n.ownerId === card.ownerId
              );
            const activatedColorClass =
              isLictorActive || isNoctuleActive || isHydraOneOther || isHopliteRowOfThree ? "text-blue-500 dark:text-blue-400" : "";
            const penalizedColorClass =
              isUsurperThreatened || isBearBoxedIn || isDyingGodMaxed || isWarlordTwoPlusOther ? "text-red-600 dark:text-red-500" : "";
            const maxedColorClass = isZeusBornMaxed || isHornblowerBoostingOwnHoplite ? "text-yellow-400 dark:text-yellow-300" : "";
            const bonusMaxedColorClass =
              isHipparchMaxed || isNightjarMaxed || isHydraTwoPlusOther || isConciliatorMaxed || isHopliteBoosted
                ? "text-green-600 dark:text-green-400"
                : "";
            // Warlord only -- orange with exactly 1 other copy, red (folded into
            // penalizedColorClass above) with 2+. New color, doesn't collide with
            // anything else's tint since Warlord is its own exclusive cardId branch.
            const warlordOneOtherColorClass = isWarlordOneOther ? "text-orange-600 dark:text-orange-400" : "";
            // Hovering a known card (revealed, or your own even if still face-down)
            // shows its short effect text -- same summary as the hand/catalog, not the
            // full rules text, so a mid-game hover stays a quick glance rather than a
            // wall of text. An opponent's still-hidden card shows nothing, so no info
            // leaks before a flip. The hover listener lives on the wrapper div (not the
            // button) so it still fires even when the button itself is disabled.
            const tooltipOwner = nameFor(card.ownerId);
            // A hand card selected (any type) highlights every one of the viewer's own
            // cards on the board, face-up or still face-down -- own identity is always
            // known regardless of face state, and this is the "which cells are mine"
            // aid, not a "where are more of this type" one, so opponents' cards (even
            // an exact type match) are deliberately excluded.
            const highlighted =
              (selectedInstanceId !== null && card.ownerId === viewerId) ||
              card.instanceId === hoveredEndCardInstanceId ||
              card.ownerId === hoveredPlayerId;
            // Dying God's own hourglass (see public/card-art/DyingGod.svg) rights
            // itself as it flips face-up -- flavor for "-1 per round elapsed": the
            // sand starts running the moment it's turned over. The mid-flip reveal
            // animates from upside-down to upright (see .card-hourglass-flip in
            // globals.css), timed to the same duration as the card's own 3D flip;
            // the settled face-up state afterward is just the plain, upright icon.
            const isDyingGod = card.cardId === "DyingGod";
            // Usurper (Pretender) only -- its icon keeps spinning in place (flat 2D
            // rotation, not the card's own 3D flip) for a while after the card
            // itself has already settled face-up, several full turns each slower
            // than the last (see .card-icon-multi-spin in globals.css). Applied the
            // same way in both call sites below so it keeps spinning uninterrupted
            // as the card transitions from mid-flip to settled.
            const iconSpinClass = pretenderSpinIds.has(card.instanceId) ? "card-icon-multi-spin" : "";
            // Footman (Hoplite) only -- same "applied the same way in both call sites
            // below so it keeps animating uninterrupted across the mid-flip/settled
            // transition" idea as Pretender's spin above (see slideIds/SLIDE_MS near
            // flippingIds for why this needed its own state instead of
            // MID_FLIP_ICON_CLASS).
            const slideClass = slideIds.has(card.instanceId) ? "card-icon-slide-in" : "";
            // Beacon (Nightjar) only -- unlike Footman's slide above, the icon
            // itself stays visible through the flip; only the hop animation is
            // deferred until settled (see hopIds/HOP_MS near flippingIds).
            const hopClass = hopIds.has(card.instanceId) ? "card-icon-hop" : "";
            // Commander/Mercenary only -- same "blank through the flip, animate only
            // once settled" treatment as Footman's slide above (see chargeIds/
            // coinFlipIds near flippingIds).
            const chargeClass = chargeIds.has(card.instanceId) ? "card-icon-charge-in" : "";
            const coinFlipClass = coinFlipIds.has(card.instanceId) ? "card-icon-coin-flip" : "";
            // Lictor (Suppressor) only -- same "blank through the flip, animate only
            // once settled" treatment as Footman's slide/Commander's charge above
            // (see swordSwingIds near flippingIds).
            const swordSwingClass = swordSwingIds.has(card.instanceId) ? "card-icon-sword-swing" : "";
            // Noctule (PlagueBearer) only -- same "blank through the flip, animate
            // only once settled" treatment as Footman's slide/Commander's charge
            // above (see noctuleFlyInIds/NOCTULE_FLY_IN_MS near flippingIds).
            const noctuleFlyInClass = noctuleFlyInIds.has(card.instanceId) ? "card-icon-noctule-fly-in" : "";
            // Inquisitor (Truthseeker) only -- see TRUTHGAZE_MS near flippingIds
            // for why this only applies at the settled call site.
            const truthgazeClass = truthgazeIds.has(card.instanceId) ? "card-icon-truthgaze-pulse" : "";
            // Skysplitter (Zeus-Born) only -- see CHARGE_PULSE_MS near flippingIds
            // for why this only applies at the settled call site.
            const chargePulseClass = chargePulseIds.has(card.instanceId) ? "card-icon-charge-pulse" : "";
            // Earthshaker only -- applied at both the mid-flip and settled call sites
            // (see TRUMPET_MS near flippingIds for why this can start immediately,
            // unlike Footman's slide/Commander's charge above); the ring that goes
            // with it is a separate sibling overlay (see trumpetIds below), not an
            // icon class.
            const trumpetShakeClass = trumpetIds.has(card.instanceId) ? "card-icon-trumpet-shake" : "";
            const midFlipIconClass = MID_FLIP_ICON_CLASS[card.cardId] ?? "";
            // A function, not a precomputed value, so the two call sites below (the
            // plain face-up render and the mid-flip 3D reveal -- see flippingIds
            // above) can each pass their own icon rotation treatment while staying
            // identical otherwise, so they never drift out of sync with each other.
            // `hideIcon` (Giant Bear only, while pawDropIds has this card) leaves the
            // icon slot empty -- the falling paw overlay below is the only copy of
            // the icon visible until it actually lands.
            const renderFaceUpContent = (iconExtraClass: string, hideIcon = false) => (
              <>
                {/* Keyed off the cell's own rendered size (@container), not the
                    viewport -- an 8p board's cells can be too small to show a
                    readable name even on a wide desktop screen, and a 2-3p board's
                    cells can be plenty roomy even on a phone. 72px (not 52px) --
                    verified against the longest card name ("Shieldbearer") plus the
                    button's own p-1 padding: below that it still truncates with an
                    ellipsis mid-word, which is arguably worse than just not showing
                    it at all. */}
                <span
                  className={`hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight @[72px]:block ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}
                >
                  {def.name}
                </span>
                {hideIcon ? (
                  <span className="h-1/2 w-1/2 shrink-0" />
                ) : (
                  <CardArt
                    cardId={card.cardId}
                    className={`h-1/2 w-1/2 shrink-0 ${
                      faded || isNegated
                        ? "text-zinc-400 dark:text-zinc-500"
                        : `${activatedColorClass} ${warlordOneOtherColorClass} ${penalizedColorClass} ${maxedColorClass} ${bonusMaxedColorClass}`
                    } ${iconExtraClass}`}
                  />
                )}
                <span className={`text-[length:clamp(9px,26cqw,15px)] leading-none font-bold ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}>
                  {def.base}
                </span>
              </>
            );
            const tooltipDetail = displayFaceUp
              ? `${def.name} (${def.base}) — ${def.text}`
              : card.ownerId === viewerId
                ? `${def.name} (${def.base}) — ${def.text} — only visible to you`
                : "face-down card";
            // Only once the game has ended does a score breakdown exist -- see Game()'s
            // `resolvedCards`, computed once and shared with EndScreen's summary table.
            const resolvedCard = resolvedCards?.get(card.instanceId);
            // Lazaret (championOfTheWeak) only -- a small green "buffed" cross in
            // the card's top-right corner once the game has ended and this
            // specific card was the one doubled (each player's own single lowest
            // card). Keyed off the breakdown's own label rather than re-deriving
            // "am I the lowest" here, so it can never drift out of sync with
            // championOfTheWeak's real postResolution logic.
            const wasLazaretBuffed =
              state.config.centerEffect === "championOfTheWeak" &&
              !!resolvedCard?.breakdown.some((d) => d.label.includes(CENTER_EFFECTS.championOfTheWeak.label));
            // Dragon Gate (summit) only -- a small gate badge once the game has
            // ended and this specific card was the one doubled (each player's own
            // single highest face-up card). Same "keyed off the real breakdown
            // label" reasoning as Lazaret's own badge above.
            const wasSummitDoubled =
              state.config.centerEffect === "summit" &&
              !!resolvedCard?.breakdown.some((d) => d.label.includes(CENTER_EFFECTS.summit.label));
            // Kingslayer's Court only -- a small sword badge (reusing the location's
            // own kingslayer.svg icon, same "no dedicated badge asset needed" treatment
            // as Mirror Pool's own badge) once the game has ended and this specific
            // card was one of the ones Kingslayer's post-resolution hit. Read directly
            // off the real `kingslayerHit` list (not re-derived from the breakdown
            // label like Lazaret's/Dragon Gate's own badges above) since that list is
            // exactly, and only, the instanceIds postResolution actually hit.
            const wasKingslayerHit = state.config.centerEffect === "kingslayer" && (kingslayerHit?.includes(card.instanceId) ?? false);
            // Card-effect icons -- a NEW top-left badge convention (stacking downward
            // when more than one applies), separate from the top-right LOCATION-effect
            // badges above. Deliberately narrow (just these two) rather than one per
            // disruptor card (Earthshaker, etc.) -- kept to cases that read as a
            // genuinely different kind of information from the existing red/green
            // flip-flash system.
            //
            // Every condition here must NEVER depend on a still-hidden card's own
            // identity -- Cyclops is forceFaceUp (always public, so occupancy alone is
            // safe), and both the infected and Noctule badges below only ever seed
            // from an ALREADY-FACE-UP source card. A still-hidden Plague Rat or
            // Noctule marking its neighbors would otherwise silently reveal exactly
            // what that hidden card is before anyone actually flips it.
            const isCyclopsAdjacent = getAdjacentCards(state.board, state.config.boardBounds, pos).some((n) => n.cardId === "Giant");
            const isInfected = plagueInfection.has(card.instanceId);
            // Noctule (PlagueBearer) only -- this card is one of the 2+ matching-type
            // neighbors a face-up Noctule is currently stealing 2 points from. Re-runs
            // the exact same "2+ face-up neighbors of the same type" grouping
            // PlagueBearer.valueModifier itself uses (see cards.ts), scoped to each
            // adjacent Noctule independently, face-up-only on both ends (the Noctule
            // itself and every neighbor considered) so nothing hidden ever factors in.
            const isNoctuleAffected =
              card.faceUp &&
              adjacentPositions(pos, state.config.boardBounds).some((npos) => {
                const n = state.board.get(posKey(npos));
                if (!n || n.cardId !== "PlagueBearer" || !n.faceUp) return false;
                const matchingFaceUpNeighbors = getAdjacentCards(state.board, state.config.boardBounds, npos).filter(
                  (m) => m.faceUp && m.cardId === card.cardId
                );
                return matchingFaceUpNeighbors.length >= 2;
              });
            const tooltipId = `board:${key}`;
            return (
              <div
                key={key}
                // @container so the location badges below (Mirror Pool/Dragon Gate/
                // Kingslayer/Lazaret) can size themselves off THIS card's own
                // rendered box via cqw -- they're siblings of the button below, not
                // descendants, so the button's own @container doesn't cover them.
                // Without an @container here, cqw units fall back to some other
                // ancestor's width (or the viewport), which is why these badges
                // read as a roughly fixed size regardless of how small the card
                // itself renders (e.g. an 8-player mobile board's tiny cells) --
                // clearly oversized and non-proportional there, rather than
                // shrinking down along with everything else on the card.
                className="relative @container"
                // Hover-capable devices get real hover; touch devices get an explicit
                // tap-to-toggle instead -- never both (see useHasHover's doc comment
                // for why mixing them needs two taps on touch to ever show anything).
                // The tap toggle lives on the wrapper (not just the button) so it
                // still fires when the button itself is disabled -- most cards aren't
                // flip-clickable, and a disabled <button> never dispatches a click.
                // setActiveTooltip/toggleActiveTooltip (not local state) -- see
                // activeTooltip.ts's doc comment for why "only one tooltip open
                // anywhere in the app" needs to be a shared store, not per-component.
                onMouseEnter={
                  hasHover
                    ? (e) => {
                        setActiveRect(e.currentTarget.getBoundingClientRect());
                        setActiveTooltip(tooltipId);
                      }
                    : undefined
                }
                onMouseLeave={hasHover ? () => clearActiveTooltip(tooltipId) : undefined}
                onClick={
                  hasHover
                    ? undefined
                    : (e) => {
                        e.stopPropagation();
                        setActiveRect(e.currentTarget.getBoundingClientRect());
                        toggleActiveTooltip(tooltipId);
                      }
                }
              >
                <button
                  // Not a native `disabled` attribute -- see Hand.tsx's own card
                  // button for why: disabled buttons unreliably suppress mouse events
                  // across browsers, including mouseenter on the wrapping div above
                  // (which is what actually listens for hover), silently killing this
                  // card's hover/tooltip whenever it isn't flip-clickable right now.
                  onClick={() => {
                    if (clickable) onCellClick(pos);
                  }}
                  draggable={!!onCardDragStart}
                  onDragStart={onCardDragStart ? (e) => onCardDragStart(e, card.instanceId, pos) : undefined}
                  onDragEnd={onCardDragEnd}
                  aria-disabled={!clickable}
                  title={clickable ? "Tap to flip face-up" : undefined}
                  className={`@container flex aspect-square w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border-2 p-1 text-center ${ownerColorClass(state, card.ownerId)} ${
                    clickable ? "cursor-pointer ring-2 ring-amber-400" : ""
                  } ${highlighted ? "ring-2 ring-sky-400 dark:ring-sky-500" : ""} ${flippingIds.has(card.instanceId) ? "[perspective:600px]" : ""} ${
                    earthshakenIds.has(card.instanceId) ? "card-earthshake-wobble" : disruptedIds.has(card.instanceId) ? "card-disrupted" : ""
                  } ${boostedIds.has(card.instanceId) ? "card-boosted" : ""} ${effectHighlightClass}`}
                >
                  {flippingIds.has(card.instanceId) ? (
                    // Briefly renders BOTH faces stacked in 3D (see .card-flip-* in
                    // globals.css) while the reveal animation plays, then this whole
                    // branch stops applying (see FLIP_ANIMATION_MS above) and settles
                    // into the plain single-branch render below, same as always.
                    <div className="card-flip-inner">
                      <div className="card-flip-face flex items-center justify-center">
                        <div className={`card-back-pattern h-full w-full opacity-40 ${ownerTextColorClass(state, card.ownerId)}`} />
                      </div>
                      <div className="card-flip-face card-flip-face-back flex flex-col items-center justify-center gap-0.5">
                        {renderFaceUpContent(
                          `${isDyingGod ? "card-hourglass-flip" : ""} ${iconSpinClass} ${trumpetShakeClass} ${midFlipIconClass}`,
                          pawDropIds.has(card.instanceId) ||
                            slamIds.has(card.instanceId) ||
                            igniteIds.has(card.instanceId) ||
                            slideIds.has(card.instanceId) ||
                            chargeIds.has(card.instanceId) ||
                            coinFlipIds.has(card.instanceId) ||
                            swordSwingIds.has(card.instanceId) ||
                            noctuleFlyInIds.has(card.instanceId) ||
                            crumbleIds.has(card.instanceId)
                        )}
                      </div>
                    </div>
                  ) : displayFaceUp ? (
                    renderFaceUpContent(
                      `${iconSpinClass} ${slideClass} ${hopClass} ${chargeClass} ${coinFlipClass} ${swordSwingClass} ${noctuleFlyInClass} ${truthgazeClass} ${chargePulseClass} ${trumpetShakeClass}`,
                      pawDropIds.has(card.instanceId) || slamIds.has(card.instanceId) || igniteIds.has(card.instanceId) || crumbleIds.has(card.instanceId)
                    )
                  ) : (
                    <div className={`card-back-pattern h-full w-full opacity-40 ${ownerTextColorClass(state, card.ownerId)}`} />
                  )}
                </button>
                {risingIds.has(card.instanceId) && (
                  // A forceFaceUp card (Cyclops) has no face-down state to flip away
                  // from -- it's revealed the instant it's placed, not flipped later --
                  // so instead of the two-face flip above, the real card underneath
                  // stays put at its normal size, and a larger copy of just its icon
                  // rises up out of it and looms above the board for a moment before
                  // fading, like the eye emerging (see .card-rise-overlay in
                  // globals.css). `overflow-hidden` on the button above never clips
                  // this -- it's a sibling, not a descendant, of the button.
                  <div className="card-rise-overlay pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                    <CardArt cardId={card.cardId} className="h-full w-full drop-shadow-lg" />
                  </div>
                )}
                {heraldRiseIds.has(card.instanceId) && (
                  // Doomherald (Chronicler) only -- same idea as Cyclops's rise
                  // above (real card underneath stays put, a larger copy of the icon
                  // pops up and looms before fading), just bigger and slightly
                  // longer-lived (see .card-herald-rise-overlay in globals.css) and
                  // triggered off a real flip (newlyFlipped) instead of a
                  // forceFaceUp card's first sighting (newlyRisen).
                  <div className="card-herald-rise-overlay pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                    <CardArt cardId={card.cardId} className="h-full w-full drop-shadow-lg" />
                  </div>
                )}
                {pawDropIds.has(card.instanceId) && (
                  // Giant Bear (Exile) only -- the reverse of Cyclops's rise: the
                  // real card underneath is left with an empty icon slot (see
                  // renderFaceUpContent's hideIcon) while a larger copy of the icon
                  // drops down and settles into place, like a paw stomping down (see
                  // .card-paw-drop in globals.css). A sibling of the button, not a
                  // descendant, so its own overflow-hidden never clips it. Mirrors
                  // renderFaceUpContent's own flex-col layout exactly (same hidden
                  // name span, same h-1/2 icon, same value span, just invisible
                  // instead of gone) so the icon lands in precisely the same spot the
                  // real one will occupy the instant this overlay disappears --
                  // otherwise a plain centered icon here (a different position/size
                  // than the real one, which shares vertical space with the name/
                  // value text around it) visibly jumps at the handoff.
                  <div className="card-paw-drop @container pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-0.5 p-1 text-center">
                    <span className="hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight opacity-0 @[72px]:block">
                      {def.name}
                    </span>
                    <CardArt cardId={card.cardId} className="h-1/2 w-1/2 shrink-0 drop-shadow-lg" />
                    <span className="text-[length:clamp(9px,26cqw,15px)] leading-none font-bold opacity-0">{def.base}</span>
                  </div>
                )}
                {slamIds.has(card.instanceId) && (
                  // Warlord only -- same idea as Giant Bear's paw drop (real card
                  // left icon-less, a bigger copy drops in and lands in the exact
                  // same spot -- see the comment above), but harder/faster (a slam,
                  // not a gentle drop -- see .card-slam-drop in globals.css) and
                  // paired with a one-shot shockwave ring (.card-slam-shockwave)
                  // that only becomes visible right as the icon actually lands, for
                  // a real impact instead of just an arrival.
                  <>
                    <div className="card-slam-drop @container pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-0.5 p-1 text-center">
                      <span className="hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight opacity-0 @[72px]:block">
                        {def.name}
                      </span>
                      <CardArt cardId={card.cardId} className="h-1/2 w-1/2 shrink-0 drop-shadow-lg" />
                      <span className="text-[length:clamp(9px,26cqw,15px)] leading-none font-bold opacity-0">{def.base}</span>
                    </div>
                    <div className="card-slam-shockwave pointer-events-none absolute inset-[15%] z-10 rounded-full" />
                  </>
                )}
                {igniteIds.has(card.instanceId) && (
                  // Gloryseeker (Warlord/Giant Bear's own hideIcon+overlay trick) --
                  // the real card underneath is left icon-less (see renderFaceUpContent's
                  // hideIcon above) while a separate copy of the icon swoops in ablaze
                  // from the top-right corner and chars to black (see
                  // .card-ignite-materialize in globals.css), then hands off to the
                  // real icon once this overlay disappears. Mirrors renderFaceUpContent's
                  // own flex-col layout exactly, same as the paw-drop/slam overlays
                  // above, so nothing visibly jumps at the handoff.
                  <div className="card-ignite-materialize @container pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-0.5 p-1 text-center">
                    <span className="hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight opacity-0 @[72px]:block">
                      {def.name}
                    </span>
                    <CardArt cardId={card.cardId} className="h-1/2 w-1/2 shrink-0" />
                    <span className="text-[length:clamp(9px,26cqw,15px)] leading-none font-bold opacity-0">{def.base}</span>
                  </div>
                )}
                {hydraIds.has(card.instanceId) && (
                  // Berserker (Hydra) only -- the real icon stays visible the whole
                  // time (no hideIcon here, unlike the overlays above); this just
                  // drops two extra ghost copies on top of it that slide out to each
                  // side and fade away, converging back into the real one underneath
                  // (see .card-icon-hydra-ghost-left/-right in globals.css). A
                  // `filter: drop-shadow`-based version of this (offsetting via the
                  // filter instead of a real second element) rendered as no visible
                  // effect at all -- combining `filter` with CardArt's own
                  // `mask-image` is an unreliable pairing across browsers, so this
                  // uses two real, separately positioned CardArt elements instead. A
                  // sibling overlay outside the button's own overflow-hidden, same as
                  // the other overlays, since the ghosts slide out past the icon's
                  // own small box.
                  <div className="@container pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-0.5 p-1 text-center">
                    <span className="hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight opacity-0 @[72px]:block">
                      {def.name}
                    </span>
                    <div className="relative h-1/2 w-1/2 shrink-0">
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-hydra-ghost-left" />
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-hydra-ghost-right" />
                    </div>
                    <span className="text-[length:clamp(9px,26cqw,15px)] leading-none font-bold opacity-0">{def.base}</span>
                  </div>
                )}
                {plagueScatterIds.has(card.instanceId) && (
                  // Plague Rat only -- same "extra real CardArt copies, not
                  // filter/mask" idea as Hydra's ghost-split above, but five
                  // copies scattering outward in different directions and fading
                  // away (see .card-icon-scatter-1..5 in globals.css) instead of
                  // two converging back into one -- a plague spreading outward,
                  // not a hydra's heads merging. Real icon stays visible
                  // underneath the whole time, same as Hydra.
                  <div className="@container pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-0.5 p-1 text-center">
                    <span className="hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight opacity-0 @[72px]:block">
                      {def.name}
                    </span>
                    <div className="relative h-1/2 w-1/2 shrink-0">
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-scatter-1" />
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-scatter-2" />
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-scatter-3" />
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-scatter-4" />
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-scatter-5" />
                    </div>
                    <span className="text-[length:clamp(9px,26cqw,15px)] leading-none font-bold opacity-0">{def.base}</span>
                  </div>
                )}
                {crumbleIds.has(card.instanceId) && (
                  // Facestealer (Infiltrator) only -- the borrowed face cracks into
                  // four quadrant pieces (see .card-icon-crumble-piece-1..4 in
                  // globals.css, each `clip-path`-cropped to its own quarter of the
                  // icon, same real-CardArt-copy technique as Hydra/Plague Rat) that
                  // fall away and fade while the real icon underneath is hidden
                  // entirely (see hideIcon above), reappearing once the pieces are
                  // gone -- bad news for the owner getting caught, unlike every
                  // other Engine flourish here.
                  <div className="@container pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-0.5 p-1 text-center">
                    <span className="hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight opacity-0 @[72px]:block">
                      {def.name}
                    </span>
                    <div className="relative h-1/2 w-1/2 shrink-0">
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-crumble-piece-1" />
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-crumble-piece-2" />
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-crumble-piece-3" />
                      <CardArt cardId={card.cardId} className="absolute inset-0 card-icon-crumble-piece-4" />
                    </div>
                    <span className="text-[length:clamp(9px,26cqw,15px)] leading-none font-bold opacity-0">{def.base}</span>
                  </div>
                )}
                {flippingIds.has(card.instanceId) && card.cardId === "Bannerman" && (
                  // Bannerman only -- a rally-call pulse ring timed to go off right
                  // as its own icon-raise (.card-icon-raise-call, see
                  // MID_FLIP_ICON_CLASS) reaches its peak, like a horn blast rather
                  // than an impact. Doesn't need its own hideIcon/overlay-swap trick
                  // like Giant Bear/Warlord -- the icon just raises in place, so a
                  // plain ring sibling is enough.
                  <div className="card-horn-pulse pointer-events-none absolute inset-[20%] z-10 rounded-full" />
                )}
                {trumpetIds.has(card.instanceId) && (
                  // Earthshaker only -- same "icon shake plus a ring sibling" idea as
                  // Bannerman's raise-call/horn-pulse above, but starting at the same
                  // moment as the flip itself (t=0, see TRUMPET_MS near flippingIds),
                  // same as earthshakenIds' own ground-shake on its targets -- lines
                  // up the trumpet blast with the moment the disrupted cells start
                  // visibly rattling, instead of lagging behind until the card settles.
                  <div className="card-trumpet-soundwave pointer-events-none absolute inset-[20%] z-10 rounded-full" />
                )}
                {hasMirrorTypeMatch && (
                  // Mirror Pool only -- a small badge of the location's own icon in
                  // the card's top-right corner while its mirror position holds a
                  // face-up card of the exact same type (the location's own doubled
                  // "+2 each" case, not just the plain "+1 each" any occupied mirror
                  // gets). A sibling of the button, not a descendant, so the
                  // button's own overflow-hidden never clips it.
                  <LocationArt
                    id="mirrorPool"
                    className={`pointer-events-none absolute top-[clamp(1px,4cqw,4px)] right-[clamp(1px,4cqw,4px)] z-10 h-[clamp(8px,24cqw,18px)] w-[clamp(8px,24cqw,18px)] drop-shadow ${CENTER_EFFECTS.mirrorPool.themeColorClass}`}
                  />
                )}
                {wasLazaretBuffed && (
                  // Lazaret only -- a small green "+" (like a health-buff cross)
                  // in the card's top-right corner, post-game only (see
                  // resolvedCard above). No dedicated SVG asset needed for a plain
                  // plus shape, unlike Mirror Pool's/Dragon Gate's own location
                  // icons.
                  <span className="pointer-events-none absolute top-0 right-1 z-10 text-[length:clamp(10px,30cqw,18px)] leading-none font-bold text-green-500 drop-shadow-sm dark:text-green-400">
                    +
                  </span>
                )}
                {wasSummitDoubled && (
                  // Dragon Gate only -- a small, simplified version of the
                  // location's own gate icon (see LocationArt's "badge" variant)
                  // in the card's top-right corner, post-game only (see
                  // resolvedCard above), same badge treatment as Mirror Pool's own.
                  <LocationArt
                    id="summit"
                    variant="badge"
                    className={`pointer-events-none absolute top-[clamp(1px,4cqw,4px)] right-[clamp(1px,4cqw,4px)] z-10 h-[clamp(8px,24cqw,18px)] w-[clamp(8px,24cqw,18px)] drop-shadow ${CENTER_EFFECTS.summit.themeColorClass}`}
                  />
                )}
                {wasKingslayerHit && (
                  // Kingslayer's Court only -- same top-right badge treatment as
                  // Mirror Pool's own (no dedicated badge asset, just the
                  // location's real icon at a small size), marking every card
                  // Kingslayer's post-resolution hit for -kingslayerValue.
                  <LocationArt
                    id="kingslayer"
                    className={`pointer-events-none absolute top-[clamp(1px,4cqw,4px)] right-[clamp(1px,4cqw,4px)] z-10 h-[clamp(8px,24cqw,18px)] w-[clamp(8px,24cqw,18px)] drop-shadow ${CENTER_EFFECTS.kingslayer.themeColorClass}`}
                  />
                )}
                {(isCyclopsAdjacent || isNoctuleAffected || isInfected) && (
                  // Card-effect icons -- top-LEFT (as opposed to every location-effect
                  // badge above, which lives top-right), stacking downward when more
                  // than one applies at once. Each badge just reuses its source
                  // card's own existing art at this small size, same "no dedicated
                  // badge asset" convention as Mirror Pool/Kingslayer's own badges.
                  <div className="pointer-events-none absolute top-[clamp(1px,4cqw,4px)] left-[clamp(1px,4cqw,4px)] z-10 flex flex-col gap-0.5">
                    {isCyclopsAdjacent && (
                      <CardArt cardId="Giant" className="h-[clamp(8px,24cqw,18px)] w-[clamp(8px,24cqw,18px)] drop-shadow" />
                    )}
                    {isNoctuleAffected && (
                      <CardArt cardId="PlagueBearer" className="h-[clamp(8px,24cqw,18px)] w-[clamp(8px,24cqw,18px)] drop-shadow" />
                    )}
                    {isInfected && <CardArt cardId="PlagueRat" className="h-[clamp(8px,24cqw,18px)] w-[clamp(8px,24cqw,18px)] drop-shadow" />}
                  </div>
                )}
                {activeTooltipId === tooltipId && activeRect && (
                  <FixedTooltip rect={activeRect}>
                    <div className="font-semibold leading-tight">{tooltipOwner}</div>
                    <div className="leading-tight">{tooltipDetail}</div>
                    {resolvedCard && (
                      <div className="mt-1 border-t border-white/20 pt-1 dark:border-black/20">
                        <BreakdownPopup breakdown={resolvedCard.breakdown} finalValue={resolvedCard.finalValue} />
                      </div>
                    )}
                  </FixedTooltip>
                )}
              </div>
            );
          }

          return (
            <button
              key={key}
              // Not a native `disabled` attribute -- a disabled button never
              // dispatches a click event at all (by spec, not just unreliably), so a
              // tap on a non-legal cell never bubbled up to the global
              // dismiss-tooltip-on-click-elsewhere listener (see activeTooltip.ts).
              // Gating the handlers' bodies instead keeps every cell equally tappable
              // for that purpose while still doing nothing when it isn't legal.
              onClick={() => {
                if (isLegal) onCellClick(pos);
              }}
              onDragOver={(e) => {
                if (isLegal) onCellDragOver(e, key);
              }}
              onDragLeave={onCellDragLeave}
              onDrop={(e) => {
                if (isLegal) onCellDrop(e, pos);
              }}
              aria-disabled={!isLegal}
              className={`aspect-square w-full rounded-md border transition-colors ${
                isLegal
                  ? dragOverKey === key
                    ? "border-emerald-600 bg-emerald-200 dark:bg-emerald-800"
                    : "border-emerald-300/70 bg-emerald-50/50 dark:border-emerald-800/70 dark:bg-emerald-950/40"
                  : "border-zinc-200 dark:border-zinc-800"
              } ${effectHighlightClass}`}
            />
          );
        })
      )}
    </div>
  );
}
