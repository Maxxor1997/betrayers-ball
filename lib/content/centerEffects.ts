import { getAdjacentCards, inBounds, parsePosKey, posKey } from "@/lib/engine/board";
import { redrawHands, Rng } from "@/lib/engine/deck";
import { FLOORED_AT_ZERO_LABEL, type ResolvedCard } from "@/lib/engine/resolution";
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
  }) => { kingslayerHit?: string[] };

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
 * Kingslayer only: the center is "a scorable card worth KINGSLAYER_BASE_VALUE
 * (modifiable by adjacent buff/dent effects during resolution)". A fully general
 * version would mean synthesizing a fake CardInstance for the center and teaching
 * every CardId-keyed lookup (deck building, CARD_DEFS) to tolerate a non-drawable
 * pseudo-card -- real rework, not additive. This scopes it to the flat, identity-blind
 * positional modifiers: Bannerman (+1 -- center is never a Footman), Earthshaker (-1 if
 * face-up and center shares its row), Skysplitter (-3 if directly above/below).
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
        if (c.faceUp && pos.y === center.y) delta -= 1;
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
 * Base "value" of the Kingslayer pseudo-card, before computeCenterModifier's adjacency
 * adjustments -- exported so tests can compute expected totals from this instead of
 * duplicating the literal.
 */
export const KINGSLAYER_BASE_VALUE = 5;

/**
 * Live (pre-resolution) value of the center pseudo-card for Kingslayer, for UI
 * display -- same base + computeCenterModifier math postResolution uses, just run
 * against the board as it currently sits instead of at scoring time. Null for every
 * other center effect, including Champion of the Weak (The Lazaret) -- it doubles an
 * already-placed card's value rather than awarding a pseudo-card of its own, so there's
 * nothing to show a live value for.
 */
export function pseudoCardLiveValue(id: CenterEffectId, board: Board, bounds: BoardBounds, negated: Set<string>): number | null {
  if (id !== "kingslayer") return null;
  return KINGSLAYER_BASE_VALUE + computeCenterModifier(board, bounds, negated);
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
    description: "Every card gains +1 for each distinct opposing player with a card adjacent to it.",
    valueModifiers: (board, bounds, addDelta) => {
      for (const [key, c] of board.entries()) {
        const pos = parsePosKey(key);
        // Unique opponents, not a raw neighbor count -- two adjacent cards from the
        // same opponent only count once, same dedupe-by-owner shape as Warlord/
        // Berserker/Mercenary elsewhere in the deck.
        const uniqueEnemyOwners = new Set(
          getAdjacentCards(board, bounds, pos)
            .filter((n) => n.ownerId !== c.ownerId)
            .map((n) => n.ownerId)
        ).size;
        if (uniqueEnemyOwners > 0) addDelta(c.instanceId, uniqueEnemyOwners, CENTER_EFFECTS.frontier.label);
      }
    },
  },

  championOfTheWeak: {
    label: "The Lazaret",
    themeColorClass: "text-lime-700 dark:text-lime-500",
    titleHighlight: "Lazaret",
    description: "At the end of the game, each player's single lowest-valued face-down card is worth double (a tie is broken by whichever was placed last).",
    postResolution: ({ cards, totalsByOwner }) => {
      const byOwner = new Map<string, ResolvedCard[]>();
      for (const c of cards) {
        if (c.faceUp) continue;
        const list = byOwner.get(c.ownerId);
        if (list) list.push(c);
        else byOwner.set(c.ownerId, [c]);
      }
      for (const ownerCards of byOwner.values()) {
        // `cards` (and so `ownerCards`) follows board.entries() iteration order, which
        // is placement order (a Map preserves insertion order) -- `<=` (not `<`) means
        // a later card that merely ties the current lowest still overwrites it, so
        // this deterministically lands on whichever tied-for-lowest card was placed
        // last, same tiebreak convention as the Summit, no RNG needed.
        let lowest = ownerCards[0];
        for (const c of ownerCards) {
          if (c.finalValue <= lowest.finalValue) lowest = c;
        }
        const bonus = lowest.finalValue;
        lowest.breakdown.push({ label: `${CENTER_EFFECTS.championOfTheWeak.label} (lowest face-down, doubled)`, amount: bonus, source: "external" });
        lowest.finalValue += bonus;
        totalsByOwner[lowest.ownerId] = (totalsByOwner[lowest.ownerId] ?? 0) + bonus;
      }
      return {};
    },
  },

  summit: {
    label: "Dragon Gate",
    themeColorClass: "text-purple-700 dark:text-purple-500",
    titleHighlight: "Dragon",
    description: "At the end of the game, each player's single highest-valued face-up card is worth double (a tie is broken by whichever was placed last).",
    postResolution: ({ cards, totalsByOwner }) => {
      const byOwner = new Map<string, ResolvedCard[]>();
      for (const c of cards) {
        if (!c.faceUp) continue;
        const list = byOwner.get(c.ownerId);
        if (list) list.push(c);
        else byOwner.set(c.ownerId, [c]);
      }
      for (const ownerCards of byOwner.values()) {
        // `cards` (and so `ownerCards`) follows board.entries() iteration order, which
        // is placement order (a Map preserves insertion order) -- `>=` (not `>`) means
        // a later card that merely ties the current highest still overwrites it, so
        // this deterministically lands on whichever tied-for-highest card was placed
        // last, no RNG needed.
        let highest = ownerCards[0];
        for (const c of ownerCards) {
          if (c.finalValue >= highest.finalValue) highest = c;
        }
        const bonus = highest.finalValue;
        highest.breakdown.push({ label: `${CENTER_EFFECTS.summit.label} (highest face-up card, doubled)`, amount: bonus, source: "external" });
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
    description: "Flips unlock one round later than usual.",
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
    description: "Two extra ownerless tiles sit directly beside the center. Any card adjacent to any of the three heads gains +1.",
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
    description: "No adjacency requirement -- any empty tile on the board is a legal placement.",
    placementAnywhere: true,
  },

  kingslayer: {
    label: "Kingslayer's Court",
    themeColorClass: "text-red-700 dark:text-red-500",
    titleHighlight: "Kingslayer's",
    // The board tile itself just says "Kingslayer" -- "Kingslayer's Court" is the
    // location's full name (catalog, New Game picker), too long to sit on the tile.
    ownerlessLabel: "Kingslayer",
    description: `Kingslayer counts as a card worth ${KINGSLAYER_BASE_VALUE} (modified by buffs/debuffs). After scoring, its value is subtracted from the highest-value card(s) on the board -- tied cards all get hit.`,
    postResolution: ({ board, bounds, negated, cards, totalsByOwner }) => {
      if (cards.length === 0) return {};
      const kingslayerValue = KINGSLAYER_BASE_VALUE + computeCenterModifier(board, bounds, negated);
      const maxValue = Math.max(...cards.map((c) => c.finalValue));
      const kingslayerHit: string[] = [];
      for (const c of cards) {
        if (c.finalValue === maxValue) {
          const preHitValue = c.finalValue;
          c.breakdown.push({ label: `${CENTER_EFFECTS.kingslayer.ownerlessLabel} (highest value)`, amount: -kingslayerValue, source: "external" });
          c.finalValue -= kingslayerValue;
          // Same universal "never scores negative" floor the main resolution pass
          // applies to every card's own printed rule -- a post-resolution hit is no
          // exception, so a big enough Kingslayer value can't drive a card negative.
          if (c.finalValue < 0) {
            c.breakdown.push({ label: FLOORED_AT_ZERO_LABEL, amount: -c.finalValue, source: "self" });
            c.finalValue = 0;
          }
          totalsByOwner[c.ownerId] = (totalsByOwner[c.ownerId] ?? 0) - (preHitValue - c.finalValue);
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
