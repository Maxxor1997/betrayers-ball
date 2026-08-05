import { inBounds, parsePosKey, posKey } from "@/lib/engine/board";
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
  /** Static text, or a fn for effects whose wording depends on config (Shadowlands @ 2p). */
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

  /** Extra per-card value deltas applied during resolution (mirrorPool, shadowlands). */
  valueModifiers?: (board: Board, bounds: BoardBounds, addDelta: (instanceId: string, amount: number, label: string) => void) => void;

  /**
   * Post-resolution award/zeroing off final totals (championOfTheWeak, kingslayer).
   * May mutate `cards`/`totalsByOwner` in place (e.g. zeroing a card's finalValue);
   * returned fields become part of the ResolutionResult.
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

  /** Fires when a new round starts; return the (possibly unchanged) players/deck (reckoning). */
  onRoundStart?: (state: GameState, newRound: number, rng: Rng) => Pick<GameState, "players" | "deck">;

  /**
   * Overrides the full set of ownerless/unplaceable tiles (default: just the center)
   * -- e.g. Three Headed Dragon adds two extra tiles, Two Towers moves them off
   * center entirely. Populated into `BoardBounds.ownerless` once, at config-build time
   * (configForPlayerCount).
   */
  ownerlessPositions?: (bounds: BoardBounds) => Position[];
  /** UI label shown on each ownerless tile when set (e.g. "Dragon Head", "Tower"). Defaults to `label`. */
  ownerlessLabel?: string;

  /** Drops the normal adjacency requirement -- any empty, non-ownerless cell is a legal placement (freelands). */
  placementAnywhere?: boolean;
}

/**
 * Champion of the Weak only: the center is "a scorable card worth 5 (modifiable by
 * adjacent buff/dent effects during resolution)". A fully general version would mean
 * synthesizing a fake CardInstance for the center and teaching every CardId-keyed
 * lookup (deck building, CARD_DEFS) to tolerate a non-drawable pseudo-card -- real
 * rework, not additive. This scopes it to the flat, identity-blind positional
 * modifiers: Bannerman (+1 -- center is never a Footman), Earthshaker (-1 if center
 * shares its row), Skysplitter (-3 if directly above/below).
 */
function computeCenterModifier(board: Board, bounds: BoardBounds, negated: Set<string>): number {
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

export const CENTER_EFFECTS: Record<CenterEffectId, CenterEffectDef> = {
  none: {
    label: "None",
    description: "No special rule this game.",
    selectable: false,
  },

  mirrorPool: {
    label: "Mirror Pool",
    description:
      "Each card has one mirror position (same column, opposite side of the center row). If occupied, both cards get +1, or +2 each if they're the same card type.",
    valueModifiers: (board, bounds, addDelta) => {
      for (const [key, c] of board.entries()) {
        const pos = parsePosKey(key);
        const mirrorPos = { x: pos.x, y: 2 * bounds.center.y - pos.y };
        if (mirrorPos.y === pos.y) continue; // on the center row itself -- no distinct mirror
        const mirrorCard = board.get(posKey(mirrorPos));
        if (mirrorCard) addDelta(c.instanceId, mirrorCard.cardId === c.cardId ? 2 : 1, "Mirror Pool");
      }
    },
  },

  championOfTheWeak: {
    label: "Champion of the Weak",
    description: `The center counts as a card worth ${PSEUDO_CARD_BASE_VALUE} (modified by adjacent buffs/dents). After scoring, it's transferred to the owner of the single lowest-valued card on the board — a tie for lowest means no transfer.`,
    postResolution: ({ board, bounds, negated, cards, totalsByOwner }) => {
      if (cards.length === 0) return {};
      const centerValue = PSEUDO_CARD_BASE_VALUE + computeCenterModifier(board, bounds, negated);
      const minValue = Math.min(...cards.map((c) => c.finalValue));
      const lowest = cards.filter((c) => c.finalValue === minValue);
      if (lowest.length !== 1) return {};
      const ownerId = lowest[0].ownerId;
      totalsByOwner[ownerId] = (totalsByOwner[ownerId] ?? 0) + centerValue;
      return { centerAward: { value: centerValue, ownerId } };
    },
  },

  kingslayer: {
    label: "Kingslayer",
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
          c.breakdown.push({ label: "Kingslayer (highest face-up value)", amount: -kingslayerValue });
          c.finalValue -= kingslayerValue;
          kingslayerHit.push(c.instanceId);
        }
      }
      return { kingslayerHit };
    },
  },

  shadowlands: {
    label: "Shadowlands",
    description: "Face-down cards score +1",
    valueModifiers: (board, _bounds, addDelta) => {
      for (const c of board.values()) {
        addDelta(c.instanceId, c.faceUp ? 0 : 1, "Shadowlands");
      }
    },
  },

  reckoning: {
    label: "The Reckoning",
    description: "At the start of round 4, every player discards their hand and draws the same number of fresh cards.",
    onRoundStart: (state, newRound, rng) => {
      if (newRound !== RECKONING_TRIGGER_ROUND) return { players: state.players, deck: state.deck };
      const { players, remainingDeck } = redrawHands(state.deck, state.players, rng);
      return { players, deck: remainingDeck };
    },
  },

  threeHeadedDragon: {
    label: "Three Headed Dragon",
    description: "Two extra ownerless tiles flank the center, two cells out along its row.",
    ownerlessLabel: "Dragon Head",
    ownerlessPositions: (bounds) => {
      const { x, y } = bounds.center;
      return [{ x, y }, { x: x - 2, y }, { x: x + 2, y }].filter((p) => inBounds(p, bounds));
    },
  },

  twoTowers: {
    label: "Two Towers",
    description: "The center is free to play on. Instead, the ownerless tiles sit at the far left and far right ends of its row.",
    ownerlessLabel: "Tower",
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
    description: "No adjacency requirement -- any empty tile on the board is a legal placement",
    placementAnywhere: true,
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
