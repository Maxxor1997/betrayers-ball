import { getAdjacentCards, inBounds, parsePosKey, posKey } from "@/lib/engine/board";
import { redrawHands, Rng } from "@/lib/engine/deck";
import type { ResolvedCard } from "@/lib/engine/resolution";
import { Board, BoardBounds, CardInstance, CenterEffectId, GameConfig, GameState, Position } from "@/lib/engine/types";

/**
 * One entry per CenterEffectId, holding both its UI copy and every hook the engine
 * needs to call to implement it. This is the single place to look when adding,
 * changing, or removing a center effect — resolution.ts/turns.ts/game.ts only ever
 * do generic `CENTER_EFFECTS[id].someHook?.(...)` lookups, so they don't change when
 * an effect is added.
 */
export interface CenterEffectDef {
  label: string;
  /**
   * Tailwind text-color classes (light + dark variant) used for the big stylized
   * location title on the gameplay screen (single-player /play, multiplayer
   * host/join) -- one hue per location, picked to fit its theme/flavor, the same way
   * the home screen's own title picks out "Kingslayer" in crimson.
   */
  themeColorClass: string;
  /**
   * The substring of `label` to render in `themeColorClass` on the gameplay-screen
   * title -- everything else in `label` stays the default foreground color, echoing
   * the home screen's own two-tone "Court of the *Kingslayer*" treatment. Must be an
   * exact substring of `label` (see splitTitle below); doesn't have to be a suffix --
   * e.g. Kingslayer's Court highlights "Kingslayer's" (the start), not "Court", to
   * stay consistent with which half the home screen already colors for that name.
   */
  titleHighlight: string;
  /** Static text, or a fn for effects whose wording depends on config. */
  description: string | ((config: GameConfig) => string);
  /** Shows up in the New Game picker. Default true — set false to hide (e.g. "none"). */
  selectable?: boolean;
  /** Eligible for a "Random" draw. Default true. */
  randomPool?: boolean;
  /** Lowest player count this effect is available at. Default MIN_PLAYERS (no floor). */
  minPlayerCount?: number;
  /** Highest player count this effect is available at. Default MAX_PLAYERS (no ceiling). */
  maxPlayerCount?: number;
  /** If true, this effect is unavailable at every player count -- overrides `minPlayerCount`/`maxPlayerCount`. */
  disabled?: boolean;

  /** Extra per-card value deltas applied during resolution. */
  valueModifiers?: (board: Board, bounds: BoardBounds, addDelta: (instanceId: string, amount: number, label: string) => void) => void;

  /**
   * Post-resolution award/zeroing off final totals. May mutate `cards`/`totalsByOwner`
   * in place (e.g. zeroing a card's finalValue); returned fields become part of the
   * ResolutionResult.
   */
  postResolution?: (ctx: {
    board: Board;
    bounds: BoardBounds;
    negated: Set<string>;
    cards: ResolvedCard[];
    totalsByOwner: Record<string, number>;
    playerIds?: string[];
  }) => { centerAward?: { value: number; ownerId: string } | null; kingslayerHit?: string[] };

  /** Overrides the default `round >= flipUnlockRound` gate. Unused by any current effect -- kept for a future round-gating effect. */
  flipGate?: (round: number, config: GameConfig) => boolean;
  /** Restricts which face-down cards may be flip targets. Unused by any current effect -- kept for a future targeting effect. */
  flipTargetFilter?: (targets: CardInstance[], playerId: string) => CardInstance[];

  /** Fires when a new round starts; return the (possibly unchanged) players/deck. */
  onRoundStart?: (state: GameState, newRound: number, rng: Rng) => Pick<GameState, "players" | "deck">;

  /**
   * Overrides the full set of ownerless/unplaceable tiles (default: just the center)
   * -- e.g. an effect could add extra tiles, or move them off center entirely.
   * Populated into `BoardBounds.ownerless` once, at config-build time
   * (configForPlayerCount).
   */
  ownerlessPositions?: (bounds: BoardBounds) => Position[];
  /** UI label shown on each ownerless tile when set. Defaults to `label`. */
  ownerlessLabel?: string;

  /** Drops the normal adjacency requirement -- any empty, non-ownerless cell is a legal placement. */
  placementAnywhere?: boolean;
}

/**
 * Kingslayer only (Champion of the Weak/Lazaret pays out a flat PSEUDO_CARD_BASE_VALUE
 * with no adjacency modifier -- see its postResolution below): the center is "a
 * scorable card worth PSEUDO_CARD_BASE_VALUE (modifiable by adjacent buff/dent effects
 * during resolution)". A fully general version would mean synthesizing a fake
 * CardInstance for the center and teaching every CardId-keyed lookup (deck building,
 * CARD_DEFS) to tolerate a non-drawable pseudo-card -- real rework, not additive. This
 * scopes it to the flat, identity-blind positional modifiers: Bannerman (+1 -- center
 * is never a Footman), Earthshaker (-1 if center shares its row), Skysplitter (-3 if
 * directly above/below).
 */
export function computeCenterModifier(board: Board, bounds: BoardBounds, negated: Set<string>): number {
  let delta = 0;
  const center = bounds.center;
  for (const [key, c] of board.entries()) {
    if (negated.has(c.instanceId)) continue;
    const pos = parsePosKey(key);
    const dx = Math.abs(pos.x - center.x);
    const dy = Math.abs(pos.y - center.y);

    switch (c.cardId) {
      case "Bannerman":
        if (dx + dy === 1) delta += 1;
        break;
      case "Earthshaker":
        if (pos.y === center.y) delta -= 1;
        break;
      case "Skysplitter":
        if (pos.x === center.x && dy === 1) delta -= 3;
        break;
      default:
        break;
    }
  }
  return delta;
}

/** Round the Reckoning center effect fires on -- discard & redraw every hand. */
const RECKONING_TRIGGER_ROUND = 4;

/**
 * Base "value" of the Champion of the Weak / Kingslayer pseudo-card, before
 * computeCenterModifier's adjacency adjustments -- exported so tests can compute
 * expected totals from this instead of duplicating the literal.
 */
export const PSEUDO_CARD_BASE_VALUE = 3;

/**
 * Live (pre-resolution) value of the center pseudo-card for Champion of the Weak /
 * Kingslayer, for UI display -- same base + computeCenterModifier math postResolution
 * uses, just run against the board as it currently sits instead of at scoring time.
 * Null for every other center effect, which has no pseudo-card to show a value for.
 */
export function pseudoCardLiveValue(id: CenterEffectId, board: Board, bounds: BoardBounds, negated: Set<string>): number | null {
  if (id === "championOfTheWeak") return PSEUDO_CARD_BASE_VALUE;
  if (id !== "kingslayer") return null;
  return PSEUDO_CARD_BASE_VALUE + computeCenterModifier(board, bounds, negated);
}

/** Splits a location's label around its titleHighlight for a two-tone title (default-color prefix/suffix, themeColorClass-colored highlight) -- see CenterEffectDef.titleHighlight. Falls back to the whole label as the highlight if it's somehow not found (shouldn't happen for any real entry below). */
export function splitTitle(def: CenterEffectDef): { prefix: string; highlight: string; suffix: string } {
  const i = def.label.indexOf(def.titleHighlight);
  if (i === -1) return { prefix: "", highlight: def.label, suffix: "" };
  return { prefix: def.label.slice(0, i), highlight: def.titleHighlight, suffix: def.label.slice(i + def.titleHighlight.length) };
}

export const CENTER_EFFECTS: Record<CenterEffectId, CenterEffectDef> = {
  none: {
    label: "World-Tree",
    themeColorClass: "text-emerald-700 dark:text-emerald-500",
    titleHighlight: "World-Tree",
    description: "No special rule this game.",
    selectable: false,
  },

  mirrorPool: {
    label: "Mirror Pool",
    themeColorClass: "text-cyan-700 dark:text-cyan-400",
    titleHighlight: "Mirror",
    description:
      "Each card has one mirror position (same column, opposite side of the center row). If occupied, both cards get +1, or +2 each if they're the same card type.",
    valueModifiers: (board, bounds, addDelta) => {
      for (const [key, c] of board.entries()) {
        const pos = parsePosKey(key);
        const mirrorPos = { x: pos.x, y: 2 * bounds.center.y - pos.y };
        if (mirrorPos.y === pos.y) continue; // on the center row itself -- no distinct mirror
        const mirrorCard = board.get(posKey(mirrorPos));
        if (mirrorCard) addDelta(c.instanceId, mirrorCard.cardId === c.cardId ? 2 : 1, CENTER_EFFECTS.mirrorPool.label);
      }
    },
  },

  frontier: {
    label: "Contested Lands",
    themeColorClass: "text-orange-700 dark:text-orange-500",
    titleHighlight: "Contested",
    description: "+1 to every card for each opponent's card adjacent to it.",
    valueModifiers: (board, bounds, addDelta) => {
      for (const [key, c] of board.entries()) {
        const pos = parsePosKey(key);
        const enemyNeighbors = getAdjacentCards(board, bounds, pos).filter((n) => n.ownerId !== c.ownerId).length;
        if (enemyNeighbors > 0) addDelta(c.instanceId, enemyNeighbors, CENTER_EFFECTS.frontier.label);
      }
    },
  },

  championOfTheWeak: {
    label: "The Lazaret",
    themeColorClass: "text-lime-700 dark:text-lime-500",
    titleHighlight: "Lazaret",
    description: `A flat ${PSEUDO_CARD_BASE_VALUE} points, transferred at the end of scoring to the owner of the single lowest-valued card on the board — a tie for lowest means no transfer.`,
    postResolution: ({ cards, totalsByOwner }) => {
      if (cards.length === 0) return {};
      const minValue = Math.min(...cards.map((c) => c.finalValue));
      const lowest = cards.filter((c) => c.finalValue === minValue);
      if (lowest.length !== 1) return {};
      const ownerId = lowest[0].ownerId;
      totalsByOwner[ownerId] = (totalsByOwner[ownerId] ?? 0) + PSEUDO_CARD_BASE_VALUE;
      return { centerAward: { value: PSEUDO_CARD_BASE_VALUE, ownerId } };
    },
  },

  summit: {
    label: "Dragon Gate",
    themeColorClass: "text-purple-700 dark:text-purple-500",
    titleHighlight: "Dragon",
    description: "At the end of the game, each player's single highest-valued card is worth double (a tie is broken by whichever was placed first).",
    postResolution: ({ cards, totalsByOwner }) => {
      const byOwner = new Map<string, ResolvedCard[]>();
      for (const c of cards) {
        const list = byOwner.get(c.ownerId);
        if (list) list.push(c);
        else byOwner.set(c.ownerId, [c]);
      }
      for (const ownerCards of byOwner.values()) {
        const maxValue = Math.max(...ownerCards.map((c) => c.finalValue));
        // `cards` (and so `ownerCards`) follows board.entries() iteration order, which
        // is placement order (a Map preserves insertion order) -- so .find() here
        // deterministically picks whichever tied-for-highest card was placed first,
        // no RNG needed.
        const highest = ownerCards.find((c) => c.finalValue === maxValue)!;
        const bonus = highest.finalValue;
        highest.breakdown.push({ label: `${CENTER_EFFECTS.summit.label} (highest card, doubled)`, amount: bonus, source: "external" });
        highest.finalValue += bonus;
        totalsByOwner[highest.ownerId] = (totalsByOwner[highest.ownerId] ?? 0) + bonus;
      }
      return {};
    },
  },

  shadowlands: {
    label: "The Pit of Erebus",
    themeColorClass: "text-indigo-700 dark:text-indigo-500",
    titleHighlight: "Erebus",
    description: "Flips unlock one round later than usual",
    flipGate: (round, config) => round >= config.flipUnlockRound + 1,
  },

  reckoning: {
    label: "Hall of Fortunes",
    themeColorClass: "text-rose-700 dark:text-rose-500",
    titleHighlight: "Fortunes",
    description: "At the start of round 4, every player discards their hand and draws the same number of fresh cards.",
    onRoundStart: (state, newRound, rng) => {
      if (newRound !== RECKONING_TRIGGER_ROUND) return { players: state.players, deck: state.deck };
      const { players, remainingDeck } = redrawHands(state.deck, state.players, rng);
      return { players, deck: remainingDeck };
    },
  },

  threeHeadedDragon: {
    label: "Corpse of the Great Wyrm",
    themeColorClass: "text-fuchsia-700 dark:text-fuchsia-500",
    titleHighlight: "Wyrm",
    description: "Two extra ownerless tiles sit directly beside the center, touching along its row. +1 to any card adjacent to any of the three.",
    ownerlessLabel: "Wyrm Head",
    ownerlessPositions: (bounds) => {
      const { x, y } = bounds.center;
      return [{ x, y }, { x: x - 1, y }, { x: x + 1, y }].filter((p) => inBounds(p, bounds));
    },
    valueModifiers: (board, bounds, addDelta) => {
      const heads = bounds.ownerless ?? [bounds.center];
      for (const [key, c] of board.entries()) {
        const pos = parsePosKey(key);
        const adjacentToHead = heads.some((h) => Math.abs(h.x - pos.x) + Math.abs(h.y - pos.y) === 1);
        if (adjacentToHead) addDelta(c.instanceId, 1, CENTER_EFFECTS.threeHeadedDragon.label);
      }
    },
  },

  twoTowers: {
    label: "Twin Isles",
    themeColorClass: "text-teal-700 dark:text-teal-500",
    titleHighlight: "Isles",
    description: "The center is free to play on. Instead, the ownerless tiles sit at the far left and far right ends of its row.",
    ownerlessLabel: "Island",
    ownerlessPositions: (bounds) => {
      const { y } = bounds.center;
      return [
        { x: 0, y },
        { x: bounds.width - 1, y },
      ];
    },
  },

  freeCities: {
    label: "The Free Cities",
    themeColorClass: "text-amber-600 dark:text-amber-400",
    titleHighlight: "Free",
    description: "No adjacency requirement -- any empty tile on the board is a legal placement",
    placementAnywhere: true,
  },

  kingslayer: {
    label: "Kingslayer's Court",
    themeColorClass: "text-red-700 dark:text-red-500",
    titleHighlight: "Kingslayer's",
    // The board tile itself just says "Kingslayer" -- "Kingslayer's Court" is the
    // location's full name (catalog, New Game picker), too long to sit on the tile.
    ownerlessLabel: "Kingslayer",
    description: `Kingslayer counts as a card worth ${PSEUDO_CARD_BASE_VALUE} (modified by adjacent buffs/dents, same as the center). After scoring, its value is subtracted from the highest-value face-up card(s) on the board -- ties still all get hit.`,
    postResolution: ({ board, bounds, negated, cards, totalsByOwner }) => {
      const faceUpCards = cards.filter((c) => c.faceUp);
      if (faceUpCards.length === 0) return {};
      const kingslayerValue = PSEUDO_CARD_BASE_VALUE + computeCenterModifier(board, bounds, negated);
      const maxValue = Math.max(...faceUpCards.map((c) => c.finalValue));
      const kingslayerHit: string[] = [];
      for (const c of faceUpCards) {
        if (c.finalValue === maxValue) {
          totalsByOwner[c.ownerId] = (totalsByOwner[c.ownerId] ?? 0) - kingslayerValue;
          c.breakdown.push({ label: `${CENTER_EFFECTS.kingslayer.ownerlessLabel} (highest face-up value)`, amount: -kingslayerValue, source: "external" });
          c.finalValue -= kingslayerValue;
          kingslayerHit.push(c.instanceId);
        }
      }
      return { kingslayerHit };
    },
  },
};

/** Whether `id` is available at `playerCount` players, per its `minPlayerCount`/`maxPlayerCount` (e.g. "only for larger boards"). */
export function isAvailableAtPlayerCount(id: CenterEffectId, playerCount: number): boolean {
  const def = CENTER_EFFECTS[id];
  if (def.disabled) return false;
  if (def.minPlayerCount !== undefined && playerCount < def.minPlayerCount) return false;
  if (def.maxPlayerCount !== undefined && playerCount > def.maxPlayerCount) return false;
  return true;
}

/** The real effects explicitly selectable in the New Game popup at `playerCount` players ("None" and "Random" are hardcoded separately). */
export function selectableCenterEffects(playerCount: number): CenterEffectId[] {
  return (Object.keys(CENTER_EFFECTS) as CenterEffectId[]).filter(
    (id) => CENTER_EFFECTS[id].selectable !== false && isAvailableAtPlayerCount(id, playerCount)
  );
}

/** What a "Random" draw at `playerCount` players picks from -- unlike explicit selection, this includes "none". */
export function randomCenterEffectPool(playerCount: number): CenterEffectId[] {
  return (Object.keys(CENTER_EFFECTS) as CenterEffectId[]).filter(
    (id) => CENTER_EFFECTS[id].randomPool !== false && isAvailableAtPlayerCount(id, playerCount)
  );
}

export function centerEffectLabel(id: CenterEffectId): string {
  return CENTER_EFFECTS[id].label;
}

export function centerEffectDescription(id: CenterEffectId, config: GameConfig): string {
  const d = CENTER_EFFECTS[id].description;
  return typeof d === "function" ? d(config) : d;
}
