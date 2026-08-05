import { parsePosKey, posKey } from "./board";
import { redrawHands, Rng } from "./deck";
import type { ResolvedCard } from "./resolution";
import { Board, BoardBounds, CardInstance, CenterEffectId, GameConfig, GameState } from "./types";

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

  /** Extra per-card value deltas applied during resolution (noMansLand, mirrorPool). */
  valueModifiers?: (board: Board, bounds: BoardBounds, addDelta: (instanceId: string, amount: number) => void) => void;

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
  }) => { centerAward?: { value: number; ownerId: string } | null; kingslayerZeroed?: string[] };

  /** Overrides the default `round >= flipUnlockRound` gate (shadowlands, pryingEyes). */
  flipGate?: (round: number, config: GameConfig) => boolean;
  /** Restricts which face-down cards may be flip targets (pryingEyes: not your own). */
  flipTargetFilter?: (targets: CardInstance[], playerId: string) => CardInstance[];

  /** Fires when a new round starts; return the (possibly unchanged) players/deck (reckoning). */
  onRoundStart?: (state: GameState, newRound: number, rng: Rng) => Pick<GameState, "players" | "deck">;
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

export const CENTER_EFFECTS: Record<CenterEffectId, CenterEffectDef> = {
  none: {
    label: "None",
    description: "No special rule this game.",
    selectable: false,
  },

  noMansLand: {
    label: "No Man's Land",
    description: "Every placed card on the center's row or column scores −2. The center tile itself is exempt.",
    valueModifiers: (board, bounds, addDelta) => {
      for (const [key, c] of board.entries()) {
        const pos = parsePosKey(key);
        if (pos.x === bounds.center.x || pos.y === bounds.center.y) addDelta(c.instanceId, -2);
      }
    },
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
        if (mirrorCard) addDelta(c.instanceId, mirrorCard.cardId === c.cardId ? 2 : 1);
      }
    },
  },

  championOfTheWeak: {
    label: "Champion of the Weak",
    description:
      "The center counts as a card worth 5 (modified by adjacent buffs/dents). After scoring, it's transferred to the unique last-place player — a tie for last means no transfer.",
    postResolution: ({ board, bounds, negated, totalsByOwner, playerIds }) => {
      const centerValue = 5 + computeCenterModifier(board, bounds, negated);
      const ids = playerIds ?? Object.keys(totalsByOwner);
      if (ids.length === 0) return {};
      const minTotal = Math.min(...ids.map((id) => totalsByOwner[id] ?? 0));
      const lowest = ids.filter((id) => (totalsByOwner[id] ?? 0) === minTotal);
      if (lowest.length !== 1) return {};
      const ownerId = lowest[0];
      totalsByOwner[ownerId] = (totalsByOwner[ownerId] ?? 0) + centerValue;
      return { centerAward: { value: centerValue, ownerId } };
    },
  },

  kingslayer: {
    label: "Kingslayer",
    description: "After scoring, the highest-value card(s) on the board are set to 0. Ties zero all of them.",
    postResolution: ({ cards, totalsByOwner }) => {
      if (cards.length === 0) return {};
      const maxValue = Math.max(...cards.map((c) => c.finalValue));
      const kingslayerZeroed: string[] = [];
      for (const c of cards) {
        if (c.finalValue === maxValue) {
          totalsByOwner[c.ownerId] = (totalsByOwner[c.ownerId] ?? 0) - c.finalValue;
          c.finalValue = 0;
          kingslayerZeroed.push(c.instanceId);
        }
      }
      return { kingslayerZeroed };
    },
  },

  shadowlands: {
    label: "Shadowlands",
    description: (config) =>
      config.playerCount === 2
        ? "At 2p, this disables flipping for the entire game instead of the usual rounds 2, 4, and 6."
        : "Flipping is only allowed on rounds 2, 4, and 6.",
    flipGate: (round, config) => {
      if (config.playerCount === 2) return false;
      if (round < config.flipUnlockRound) return false;
      return (round - config.flipUnlockRound) % 2 === 0;
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

  pryingEyes: {
    label: "Prying Eyes",
    description: "Flipping is unlocked from round 1, but you can never flip your own cards -- only opponents'.",
    flipGate: () => true,
    flipTargetFilter: (targets, playerId) => targets.filter((c) => c.ownerId !== playerId),
  },
};

/** The real effects explicitly selectable in the New Game popup ("None" and "Random" are hardcoded separately). */
export const SELECTABLE_CENTER_EFFECTS: CenterEffectId[] = (Object.keys(CENTER_EFFECTS) as CenterEffectId[]).filter(
  (id) => CENTER_EFFECTS[id].selectable !== false
);

/** What a "Random" draw picks from -- unlike explicit selection, this includes "none". */
export const RANDOM_CENTER_EFFECT_POOL: CenterEffectId[] = (Object.keys(CENTER_EFFECTS) as CenterEffectId[]).filter(
  (id) => CENTER_EFFECTS[id].randomPool !== false
);

export function centerEffectLabel(id: CenterEffectId): string {
  return CENTER_EFFECTS[id].label;
}

export function centerEffectDescription(id: CenterEffectId, config: GameConfig): string {
  const d = CENTER_EFFECTS[id].description;
  return typeof d === "function" ? d(config) : d;
}
