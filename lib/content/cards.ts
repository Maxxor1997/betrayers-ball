import { adjacentPositions, countAdjacentOccupied, getAdjacentCards, isInFootmanLine, parsePosKey, posKey } from "@/lib/engine/board";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { Board, BoardBounds, CardBucket, CardId, CardInstance, Position } from "@/lib/engine/types";

/** Context passed to a card's `valueModifier` hook during resolution's value-modifying pass. */
export interface CardEffectContext {
  board: Board;
  bounds: BoardBounds;
  round: number;
  pos: Position;
  self: CardInstance;
  /** `label` identifies the source in a per-card scoring breakdown (e.g. "Bannerman (neighbor)"). */
  addDelta: (instanceId: string, amount: number, label: string) => void;
}

/** Context passed to a card's board-position-only hooks (negation, zeroing, placement). */
export interface CardPositionContext {
  board: Board;
  bounds: BoardBounds;
  pos: Position;
}

/**
 * One entry per CardId, holding the card's stats/text plus every hook the engine
 * needs to run its effect. This is the single place to look when adding, rebalancing,
 * or removing a card -- resolution.ts/turns.ts only ever do generic
 * `CARD_DEFS[cardId].someHook?.(...)` lookups, so they don't change when a card with
 * a *new kind* of effect is added; only a card whose effect needs a hook shape that
 * doesn't exist yet would require adding one here and wiring it into resolution.ts/
 * turns.ts once.
 */
export interface CardDef {
  id: CardId;
  name: string;
  base: number;
  bucket: CardBucket;
  /** Short human-readable effect summary, for hand/board UI. */
  text: string;
  /** Full effect description, matching game_spec.md's wording -- for hover tooltips. */
  fullText: string;
  /**
   * Deck copy count at each supported player count, indexed by `playerCount -
   * MIN_PLAYERS` (so `count[0]` is the copy count at MIN_PLAYERS players, ...,
   * `count[MAX_PLAYERS - MIN_PLAYERS]` is the copy count at MAX_PLAYERS players).
   * Use `copiesForPlayerCount()` below rather than indexing this directly. Use
   * `flatCount(n)` for a card whose count doesn't vary by player count.
   */
  count: number[];
  /** If true, this card is excluded from the deck at every player count -- overrides `count`. */
  disabled?: boolean;

  /** Forces this card face-up whenever placed -- can't be played or stay face-down (Giant). */
  forceFaceUp?: boolean;
  /** Value floors at 0 after all modifiers are applied (Warlord, Exile). */
  floorAtZero?: boolean;

  /** Value-modifying effect during resolution -- most cards with printed scoring text. */
  valueModifier?: (ctx: CardEffectContext) => void;
  /** Suppressor-only: with 3+ adjacent occupied cells, negates adjacent non-negating cards. */
  negatesNeighborsIf?: (ctx: CardPositionContext) => boolean;
  /** Placement-time trigger, distinct from valueModifier -- mutates `board` directly (Truthseeker). */
  onPlace?: (ctx: CardPositionContext) => void;
}

/** Convenience for a card whose deck count is the same at every supported player count. */
function flatCount(n: number): number[] {
  return Array(MAX_PLAYERS - MIN_PLAYERS + 1).fill(n);
}

/** The number of copies of `def` to put in the deck at `playerCount` players. */
export function copiesForPlayerCount(def: CardDef, playerCount: number): number {
  if (def.disabled) return 0;
  return def.count[playerCount - MIN_PLAYERS] ?? 0;
}

/**
 * The card set, per game_spec.md v2 plus additions (Truthseeker, Mercenary) — the
 * single source of truth for a card's stats, text, deck quantity (per player count),
 * bucket, and effect. Bucket totals and the deck size aren't locked to the spec's
 * original numbers; see lib/engine/__tests__/deck.test.ts for the current totals. The
 * counts below don't yet vary by player count, but the data shape supports it.
 */
export const CARD_DEFS: Record<CardId, CardDef> = {
  Footman: {
    id: "Footman",
    name: "Footman",
    base: 5,
    bucket: "Engine",
    text: "+1 if in a 3+ same-owner line",
    fullText: "+1 to itself if part of a line of 3+ consecutive same-owner Footmen (row or column).",
    count: flatCount(12),
    valueModifier: ({ board, pos, self, addDelta }) => {
      if (isInFootmanLine(board, pos)) addDelta(self.instanceId, 1, "Footman (3+ line)");
    },
  },
  Giant: {
    id: "Giant",
    name: "Giant",
    base: 6,
    bucket: "Slam",
    text: "Always face-up",
    fullText: "Always face-up — can't be played or stay face-down.",
    count: flatCount(4),
    forceFaceUp: true,
  },
  Warlord: {
    id: "Warlord",
    name: "Warlord",
    base: 8,
    bucket: "Slam",
    text: "−2 per other Warlord",
    fullText: "−2 per other Warlord on the board (any owner), floored at 0.",
    count: flatCount(6),
    floorAtZero: true,
    valueModifier: ({ board, self, addDelta }) => {
      let otherWarlords = 0;
      for (const other of board.values()) {
        if (other.instanceId !== self.instanceId && other.cardId === "Warlord") otherWarlords++;
      }
      if (otherWarlords > 0) addDelta(self.instanceId, -2 * otherWarlords, `Warlord (${otherWarlords} other Warlord${otherWarlords > 1 ? "s" : ""})`);
    },
  },
  Exile: {
    id: "Exile",
    name: "Exile",
    base: 9,
    bucket: "Slam",
    text: "−2 per neighbor",
    fullText: "−2 per orthogonal neighbor (any owner), floored at 0.",
    count: flatCount(4),
    floorAtZero: true,
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      const neighbors = countAdjacentOccupied(board, bounds, pos);
      if (neighbors > 0) addDelta(self.instanceId, -2 * neighbors, `Exile (${neighbors} neighbor${neighbors > 1 ? "s" : ""})`);
    },
  },
  Pretender: {
    id: "Pretender",
    name: "Pretender",
    base: 7,
    bucket: "Slam",
    text: "−3 if adj. face-up base≥self",
    fullText: "−3 to itself if any adjacent face-up card has a base ≥ its own (any owner).",
    count: flatCount(4),
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      const ownBase = CARD_DEFS[self.cardId].base;
      const dangerousNeighbor = getAdjacentCards(board, bounds, pos).some((n) => n.faceUp && CARD_DEFS[n.cardId].base >= ownBase);
      if (dangerousNeighbor) addDelta(self.instanceId, -3, "Pretender (adj. face-up base≥self)");
    },
  },
  Berserker: {
    id: "Berserker",
    name: "Berserker",
    base: 3,
    bucket: "Engine",
    text: "+2 per opposing Berserker",
    fullText: "+2 for each Berserker owned by a different player, anywhere on the board.",
    count: flatCount(8),
    valueModifier: ({ board, self, addDelta }) => {
      let otherOwnerBerserkers = 0;
      for (const other of board.values()) {
        if (other.cardId === "Berserker" && other.ownerId !== self.ownerId) otherOwnerBerserkers++;
      }
      if (otherOwnerBerserkers > 0) {
        addDelta(self.instanceId, 2 * otherOwnerBerserkers, `Berserker (${otherOwnerBerserkers} rival Berserker${otherOwnerBerserkers > 1 ? "s" : ""})`);
      }
    },
  },
  Commander: {
    id: "Commander",
    name: "Commander",
    base: 2,
    bucket: "Engine",
    text: "+2 per adjacent Footman",
    fullText: "+2 for each adjacent Footman (any owner).",
    count: flatCount(4),
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      const adjFootmen = getAdjacentCards(board, bounds, pos).filter((n) => n.cardId === "Footman").length;
      if (adjFootmen > 0) addDelta(self.instanceId, 2 * adjFootmen, `Commander (${adjFootmen} adj. ${adjFootmen > 1 ? "Footmen" : "Footman"})`);
    },
  },
  Gloryseeker: {
    id: "Gloryseeker",
    name: "Gloryseeker",
    base: 4,
    bucket: "Engine",
    text: "+3 if face-up",
    fullText: "+3 if this card is face-up at scoring.",
    count: flatCount(4),
    valueModifier: ({ self, addDelta }) => {
      if (self.faceUp) addDelta(self.instanceId, 3, "Gloryseeker (face-up)");
    },
  },
  Chronicler: {
    id: "Chronicler",
    name: "Chronicler",
    base: 2,
    bucket: "Engine",
    text: "+1 per round elapsed",
    fullText: "+1 for every round elapsed when the game ends.",
    count: flatCount(4),
    valueModifier: ({ round, self, addDelta }) => {
      if (round > 0) addDelta(self.instanceId, round, `Chronicler (round ${round} elapsed)`);
    },
  },
  Earthshaker: {
    id: "Earthshaker",
    name: "Earthshaker",
    base: 3,
    bucket: "Control",
    text: "−1 to rest of its row",
    fullText: "−1 to every other card in its row (any owner, not itself).",
    count: flatCount(4),
    valueModifier: ({ board, pos, self, addDelta }) => {
      for (const [otherKey, other] of board.entries()) {
        if (other.instanceId === self.instanceId) continue;
        if (parsePosKey(otherKey).y === pos.y) addDelta(other.instanceId, -1, "Earthshaker (same row)");
      }
    },
  },
  Skysplitter: {
    id: "Skysplitter",
    name: "Skysplitter",
    base: 3,
    bucket: "Control",
    text: "−3 above and below",
    fullText: "−3 to the card directly above and directly below.",
    count: flatCount(4),
    valueModifier: ({ board, pos, addDelta }) => {
      const above = board.get(posKey({ x: pos.x, y: pos.y - 1 }));
      const below = board.get(posKey({ x: pos.x, y: pos.y + 1 }));
      if (above) addDelta(above.instanceId, -3, "Skysplitter (vertical neighbor)");
      if (below) addDelta(below.instanceId, -3, "Skysplitter (vertical neighbor)");
    },
  },
  Bannerman: {
    id: "Bannerman",
    name: "Bannerman",
    base: 4,
    bucket: "Control",
    text: "+2 adj. Footmen, +1 others",
    fullText: "+2 to each adjacent Footman, +1 to each other adjacent card (any owner, not itself).",
    count: flatCount(6),
    valueModifier: ({ board, bounds, pos, addDelta }) => {
      for (const n of getAdjacentCards(board, bounds, pos)) {
        addDelta(n.instanceId, n.cardId === "Footman" ? 2 : 1, "Bannerman (neighbor)");
      }
    },
  },
  PlagueBearer: {
    id: "PlagueBearer",
    name: "Plague Bearer",
    base: 3,
    bucket: "Control",
    text: "Steals 2 from each same-type pair+",
    fullText:
      "For every card type that appears 2 or more times among its orthogonal neighbors (any owner, including another Plague Bearer), each of those neighbors loses 2 base points, and Plague Bearer gains that same 2 from each one -- a straight 1:1 transfer, not doubled. A neighbor type that appears only once is untouched; multiple qualifying types at once (e.g. two Footmen and two Warlords) each pay out separately.",
    count: flatCount(2),
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      const neighborsByType = new Map<CardId, CardInstance[]>();
      for (const n of getAdjacentCards(board, bounds, pos)) {
        const group = neighborsByType.get(n.cardId);
        if (group) group.push(n);
        else neighborsByType.set(n.cardId, [n]);
      }
      let stolen = 0;
      for (const group of neighborsByType.values()) {
        if (group.length < 2) continue;
        for (const n of group) {
          addDelta(n.instanceId, -2, "Plague Bearer (stolen)");
          stolen += 2;
        }
      }
      if (stolen > 0) addDelta(self.instanceId, stolen, `Plague Bearer (stole ${stolen})`);
    },
  },
  Suppressor: {
    id: "Suppressor",
    name: "Suppressor",
    base: 3,
    bucket: "Control",
    text: "3+ adj.: negates neighbors",
    fullText:
      "If 3+ adjacent cards (center counts), each adjacent non-Suppressor card is treated as vanilla — base value only, printed text negated.",
    count: flatCount(2),
    negatesNeighborsIf: ({ board, bounds, pos }) => countAdjacentOccupied(board, bounds, pos) >= 3,
  },
  Infiltrator: {
    id: "Infiltrator",
    name: "Infiltrator",
    base: 4,
    bucket: "Control",
    text: "Face-down: swaps base w/ highest adj.",
    fullText:
      "While face-down, it swaps base values with the highest-base adjacent card (any owner) -- it becomes that card's base, and that card becomes its old base.",
    count: flatCount(2),
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      if (self.faceUp) return;
      const neighbors = getAdjacentCards(board, bounds, pos);
      if (neighbors.length === 0) return;
      let target = neighbors[0];
      for (const n of neighbors) {
        if (CARD_DEFS[n.cardId].base > CARD_DEFS[target.cardId].base) target = n;
      }
      const ownBase = CARD_DEFS[self.cardId].base;
      const targetBase = CARD_DEFS[target.cardId].base;
      if (targetBase === ownBase) return;
      addDelta(self.instanceId, targetBase - ownBase, `Infiltrator (swapped w/ ${CARD_DEFS[target.cardId].name})`);
      addDelta(target.instanceId, ownBase - targetBase, "Infiltrator (swapped)");
    },
  },
  Truthseeker: {
    id: "Truthseeker",
    name: "Truthseeker",
    base: 4,
    bucket: "Control",
    text: "Placed face-up; flips all adjacent",
    fullText:
      "Always placed face-up, and immediately flips every adjacent card face-up too (any owner, including your own). Not affected by flip-lock rules or Suppressor negation.",
    count: flatCount(4),
    forceFaceUp: true,
    onPlace: ({ board, bounds, pos }) => {
      for (const neighborPos of adjacentPositions(pos, bounds)) {
        const key = posKey(neighborPos);
        const neighbor = board.get(key);
        if (neighbor && !neighbor.faceUp) {
          board.set(key, { ...neighbor, faceUp: true });
        }
      }
    },
  },
  Mercenary: {
    id: "Mercenary",
    name: "Mercenary",
    base: 2,
    bucket: "Engine",
    text: "+2 per adj. different owner",
    fullText: "+2 for each adjacent card owned by a different player.",
    count: flatCount(4),
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      const differentOwnerNeighbors = getAdjacentCards(board, bounds, pos).filter((n) => n.ownerId !== self.ownerId).length;
      if (differentOwnerNeighbors > 0) {
        addDelta(self.instanceId, 2 * differentOwnerNeighbors, `Mercenary (${differentOwnerNeighbors} different-owner neighbors)`);
      }
    },
  },
};

export const ALL_CARD_IDS: CardId[] = Object.keys(CARD_DEFS) as CardId[];
