import { adjacentPositions, countAdjacentOccupied, getAdjacentCards, isOwnerlessPosition, isPositionFaceUp, posKey } from "@/lib/engine/board";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { Board, BoardBounds, CardBucket, CardId, CardInstance, Position } from "@/lib/engine/types";

/** Context passed to a card's `valueModifier` hook during resolution's value-modifying pass. */
export interface CardEffectContext {
  board: Board;
  bounds: BoardBounds;
  round: number;
  pos: Position;
  self: CardInstance;
  /** `label` identifies the source in a per-card scoring breakdown, e.g. "<card name> (adjacent)". */
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

  /** Forces this card face-up whenever placed -- can't be played or stay face-down. */
  forceFaceUp?: boolean;
  /** While face-down, only an opponent can flip it -- its own owner can't cash in a self-triggered flip. */
  opponentOnlyFlip?: boolean;
  /** A face-down card adjacent to this one (any owner) can't be flipped by anyone, including its own owner. */
  blocksAdjacentFlips?: boolean;

  /** Value-modifying effect during resolution -- most cards with printed scoring text. */
  valueModifier?: (ctx: CardEffectContext) => void;
  /** If true for this card's position, negates adjacent non-negating cards' own modifiers and outgoing effects (base value only). Cards with this hook are immune to negation. */
  negatesNeighborsIf?: (ctx: CardPositionContext) => boolean;
  /** Placement-time trigger, distinct from valueModifier -- mutates `board` directly. */
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
 * The card set -- the single source of truth for a card's stats, text, deck quantity
 * (per player count), bucket, and effect. Add, remove, disable, or rebalance a card
 * entirely by editing an entry here (and updating `CardId` in types.ts to match); no
 * other file should need a matching edit -- see lib/engine/__tests__/deck.test.ts and
 * game_spec.md for how downstream totals/docs stay derived rather than duplicated.
 * Deck size and bucket totals are computed, not fixed; the counts below don't yet vary
 * by player count, but the data shape supports it.
 */
export const CARD_DEFS: Record<CardId, CardDef> = {
  Footman: {
    id: "Footman",
    name: "Hoplite",
    base: 5,
    bucket: "Engine",
    text: "+1 if in unbroken line of 3+ owned cards",
    get fullText() {
      return `+1 to itself if it's part of an unbroken line of 3 or more cards you own in a row or column.`;
    },
    // 6p-8p counts scaled up (along with every other active card's) so those player
    // counts don't draw nearly the whole deck into hands -- see the 6p-8p comment on
    // Giant below for the full rationale.
    count: [12, 12, 12, 12, 16, 19, 24],
    valueModifier: ({ board, pos, self, addDelta }) => {
      // Contiguous run only -- walks outward in each direction from self and stops the
      // instant a cell is empty or owned by someone else, so "3 owned cards" means an
      // unbroken line through this card, not just 3 anywhere in the row/column.
      function runLength(dx: number, dy: number): number {
        let count = 0;
        let x = pos.x + dx;
        let y = pos.y + dy;
        while (true) {
          const c = board.get(posKey({ x, y }));
          if (!c || c.ownerId !== self.ownerId) break;
          count++;
          x += dx;
          y += dy;
        }
        return count;
      }
      const rowRun = 1 + runLength(-1, 0) + runLength(1, 0);
      const colRun = 1 + runLength(0, -1) + runLength(0, 1);
      if (rowRun >= 3 || colRun >= 3) addDelta(self.instanceId, 1, `${CARD_DEFS.Footman.name} (unbroken line of 3+ owned)`);
    },
  },
  DyingGod: {
    id: "DyingGod",
    name: "Dying God",
    base: 10,
    bucket: "Slam",
    text: "−1 per round elapsed",
    fullText: "−1 for every round elapsed when the game ends.",
    count: [4, 4, 4, 4, 5, 6, 8],
    valueModifier: ({ round, self, addDelta }) => {
      if (round > 0) addDelta(self.instanceId, -round, `${CARD_DEFS.DyingGod.name} (round ${round} elapsed)`);
    },
  },
  Exile: {
    id: "Exile",
    name: "Giant Bear",
    base: 9,
    bucket: "Slam",
    text: "−1 per adj. card, −3 if boxed in",
    fullText: "−1 per adjacent card (any owner). If it has no open adjacent tile, it gets an additional −3.",
    count: [4, 4, 4, 4, 5, 6, 8],
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      const neighbors = countAdjacentOccupied(board, bounds, pos);
      if (neighbors > 0)
        addDelta(self.instanceId, -1 * neighbors, `${CARD_DEFS.Exile.name} (${neighbors} adjacent card${neighbors > 1 ? "s" : ""})`);
      const hasOpenAdjacent = adjacentPositions(pos, bounds).some((p) => !isOwnerlessPosition(p, bounds) && !board.has(posKey(p)));
      if (!hasOpenAdjacent) addDelta(self.instanceId, -3, `${CARD_DEFS.Exile.name} (no open adjacent tile)`);
    },
  },
  Warlord: {
    id: "Warlord",
    name: "Warlord",
    base: 8,
    bucket: "Slam",
    get text() {
      return `−2 per unique enemy ${CARD_DEFS.Warlord.name} owner`;
    },
    get fullText() {
      const name = CARD_DEFS.Warlord.name;
      return `−2 for each distinct opposing player with a ${name} anywhere on the board -- multiple from the same player only count once.`;
    },
    count: [6, 6, 6, 6, 8, 8, 8],
    valueModifier: ({ board, self, addDelta }) => {
      const uniqueEnemyWarlordOwners = new Set(
        [...board.values()].filter((c) => c.cardId === "Warlord" && c.ownerId !== self.ownerId).map((c) => c.ownerId)
      ).size;
      if (uniqueEnemyWarlordOwners > 0) {
        addDelta(
          self.instanceId,
          -2 * uniqueEnemyWarlordOwners,
          `${CARD_DEFS.Warlord.name} (${uniqueEnemyWarlordOwners} unique enemy ${CARD_DEFS.Warlord.name} owner${uniqueEnemyWarlordOwners > 1 ? "s" : ""})`
        );
      }
    },
  },
  Pretender: {
    id: "Pretender",
    name: "Usurper",
    base: 7,
    bucket: "Slam",
    text: "−3 if any adj. card has base ≥ self",
    fullText: "−3 if any adjacent card (any owner) has a base ≥ its own.",
    count: [4, 4, 4, 4, 5, 6, 8],
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      const ownBase = CARD_DEFS[self.cardId].base;
      const dangerousNeighbor = getAdjacentCards(board, bounds, pos).some((n) => CARD_DEFS[n.cardId].base >= ownBase);
      if (dangerousNeighbor) addDelta(self.instanceId, -3, `${CARD_DEFS.Pretender.name} (adj. base≥self)`);
    },
  },
  Berserker: {
    id: "Berserker",
    name: "Hydra",
    base: 2,
    bucket: "Engine",
    get text() {
      return `+2 per unique enemy ${CARD_DEFS.Berserker.name} owner`;
    },
    get fullText() {
      return `+2 for each distinct opposing player with a ${CARD_DEFS.Berserker.name} anywhere on the board -- multiple from the same player only count once.`;
    },
    count: [0, 0, 0, 7, 7, 7, 8],
    valueModifier: ({ board, self, addDelta }) => {
      const uniqueEnemyOwners = new Set([...board.values()].filter((c) => c.cardId === "Berserker" && c.ownerId !== self.ownerId).map((c) => c.ownerId)).size;
      if (uniqueEnemyOwners > 0) {
        addDelta(
          self.instanceId,
          2 * uniqueEnemyOwners,
          `${CARD_DEFS.Berserker.name} (${uniqueEnemyOwners} unique enemy ${CARD_DEFS.Berserker.name} owner${uniqueEnemyOwners > 1 ? "s" : ""})`
        );
      }
    },
  },
  Commander: {
    id: "Commander",
    name: "Hipparch",
    base: 4,
    bucket: "Engine",
    get text() {
      return `+2 per adj. ${CARD_DEFS.Footman.name}`;
    },
    get fullText() {
      return `+2 for each adjacent ${CARD_DEFS.Footman.name} (any owner).`;
    },
    count: [4, 4, 4, 4, 5, 6, 8],
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      const adjFootmen = getAdjacentCards(board, bounds, pos).filter((n) => n.cardId === "Footman").length;
      if (adjFootmen > 0)
        addDelta(self.instanceId, 2 * adjFootmen, `${CARD_DEFS.Commander.name} (${adjFootmen} adj. ${CARD_DEFS.Footman.name}${adjFootmen > 1 ? "s" : ""})`);
    },
  },
  Gloryseeker: {
    id: "Gloryseeker",
    name: "Pyre-Bird",
    base: 4,
    bucket: "Engine",
    text: "If face-up: +3. Can't be self-flipped",
    fullText: "+3 if this card is face-up at scoring. Can't be flipped by its owner -- only an opponent.",
    count: [4, 4, 4, 4, 5, 6, 8],
    opponentOnlyFlip: true,
    valueModifier: ({ self, addDelta }) => {
      if (self.faceUp) addDelta(self.instanceId, 3, `${CARD_DEFS.Gloryseeker.name} (face-up)`);
    },
  },
  Chronicler: {
    id: "Chronicler",
    name: "Doomherald",
    base: 5,
    bucket: "Control",
    text: "If face-up: −3 to adj. Can't be self-flipped",
    fullText:
      "−3 to every adjacent card (any owner) while this card is face-up. Can't be flipped by its owner -- only an opponent.",
    // Same modest-copy tier as the deck's other high-ceiling Control cards
    // (Suppressor/PlagueBearer) -- its worst case (up to 4 adjacent cards hit for
    // -3 each) is the biggest single-action swing in the set, so it stays rare.
    count: [2, 2, 2, 2, 3, 3, 4],
    opponentOnlyFlip: true,
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      if (!self.faceUp) return;
      for (const n of getAdjacentCards(board, bounds, pos)) {
        addDelta(n.instanceId, -3, `${CARD_DEFS.Chronicler.name} (face-up)`);
      }
    },
  },
  Giant: {
    id: "Giant",
    name: "Cyclops",
    base: 6,
    bucket: "Slam",
    text: "Always face-up. Adj. cards can't be flipped",
    fullText:
      "Always face-up -- can't be played face-down. No adjacent card (any owner) can be flipped by anyone.",
    // 6p-8p bumped up from the flat 4 (and every other active card scaled the same
    // way) -- at handSize 8, 6p-8p games were drawing 76-100% of the deck straight
    // into hands, leaving almost no unseen pool. Scaled proportionally so each card's
    // relative weight in the deck is unchanged, just the deck itself is bigger.
    count: [2, 2, 4, 4, 6, 6, 8],
    forceFaceUp: true,
    blocksAdjacentFlips: true,
  },
  Earthshaker: {
    id: "Earthshaker",
    name: "Earthshaker",
    base: 5,
    bucket: "Control",
    text: "If face-up: −2 to connected row & col",
    fullText:
      "−2 to every card (any owner, not itself) in the unbroken run of occupied cells extending along its row and its column, while this card is face-up.",
    count: [2, 2, 2, 4, 5, 5, 6],
    valueModifier: ({ board, pos, self, addDelta }) => {
      if (!self.faceUp) return;
      function walk(dx: number, dy: number) {
        let x = pos.x + dx;
        let y = pos.y + dy;
        while (true) {
          const c = board.get(posKey({ x, y }));
          if (!c) break;
          addDelta(c.instanceId, -2, `${CARD_DEFS.Earthshaker.name} (connected row/col)`);
          x += dx;
          y += dy;
        }
      }
      walk(-1, 0);
      walk(1, 0);
      walk(0, -1);
      walk(0, 1);
    },
  },
  Skysplitter: {
    id: "Skysplitter",
    name: "Zeus-Born",
    base: 4,
    bucket: "Control",
    text: "−3 above and below",
    fullText: "−3 to the card directly above and directly below (any owner).",
    count: [4, 4, 4, 4, 0, 0, 0],
    disabled: true,
    valueModifier: ({ board, pos, addDelta }) => {
      const above = board.get(posKey({ x: pos.x, y: pos.y - 1 }));
      const below = board.get(posKey({ x: pos.x, y: pos.y + 1 }));
      if (above) addDelta(above.instanceId, -3, `${CARD_DEFS.Skysplitter.name} (adjacent, vertical)`);
      if (below) addDelta(below.instanceId, -3, `${CARD_DEFS.Skysplitter.name} (adjacent, vertical)`);
    },
  },
  Bannerman: {
    id: "Bannerman",
    name: "Hornblower",
    base: 4,
    bucket: "Engine",
    get text() {
      return `+2 to adj. ${CARD_DEFS.Footman.name}, +1 to others`;
    },
    get fullText() {
      return `Gives +2 to each adjacent ${CARD_DEFS.Footman.name} (any owner), +1 to each other adjacent card.`;
    },
    count: [6, 6, 6, 6, 8, 10, 12],
    valueModifier: ({ board, bounds, pos, addDelta }) => {
      for (const n of getAdjacentCards(board, bounds, pos)) {
        addDelta(n.instanceId, n.cardId === "Footman" ? 2 : 1, `${CARD_DEFS.Bannerman.name} (adjacent)`);
      }
    },
  },
  PlagueBearer: {
    id: "PlagueBearer",
    name: "Noctule",
    base: 4,
    bucket: "Control",
    text: "Steals 2 from matching adj. pairs",
    get fullText() {
      const self = CARD_DEFS.PlagueBearer.name;
      return `If 2 or more of the cards adjacent to it are the same card type (any owner), ${self} steals 2 points from each of them. This can happen for more than one matching type at once.`;
    },
    count: [2, 2, 2, 2, 3, 3, 4],
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
          addDelta(n.instanceId, -2, `${CARD_DEFS.PlagueBearer.name} (stolen)`);
          stolen += 2;
        }
      }
      if (stolen > 0) addDelta(self.instanceId, stolen, `${CARD_DEFS.PlagueBearer.name} (stole ${stolen})`);
    },
  },
  Suppressor: {
    id: "Suppressor",
    name: "Lictor",
    base: 2,
    bucket: "Control",
    text: "If 3+ adj.: negates adj. cards",
    get fullText() {
      return `If ${CARD_DEFS.Suppressor.name} has 3+ adjacent cards, each adjacent non-${CARD_DEFS.Suppressor.name} card (any owner) is treated as vanilla -- base value only, printed text negated.`;
    },
    count: [2, 2, 2, 2, 3, 3, 4],
    negatesNeighborsIf: ({ board, bounds, pos }) => countAdjacentOccupied(board, bounds, pos) >= 3,
  },
  Infiltrator: {
    id: "Infiltrator",
    name: "Facestealer",
    base: 3,
    bucket: "Control",
    text: "If face-down: swaps w/ highest face-up adj.",
    fullText:
      "While face-down, it swaps base and printed rule with the adjacent face-up card (any owner) with the highest printed base. Multiple Facestealers can each independently swap with the same target.",
    count: [2, 2, 2, 2, 3, 3, 4],
    // No valueModifier -- the swap itself is computed once, pre-resolution, by
    // resolution.ts's computeIdentitySwaps/applyIdentitySwaps (not a per-card scoring
    // delta like every other card here). Resolution then runs entirely against the
    // swapped board -- every card's own rule, including a swapped card's neighbors'
    // rules, sees the swap as having genuinely happened -- but the *displayed*
    // cardId (board art, name, stats tracking) is restored from the original,
    // unswapped board afterward, so a swapped Facestealer is still genuinely
    // "Facestealer" to look at; only its score reflects the borrowed rule.
  },
  Truthseeker: {
    id: "Truthseeker",
    name: "Inquisitor",
    base: 5,
    bucket: "Control",
    text: "−2 to adj. face-down cards",
    fullText: "−2 to each adjacent face-down card (any owner).",
    count: [2, 2, 2, 4, 5, 6, 6],
    valueModifier: ({ board, bounds, pos, addDelta }) => {
      for (const n of getAdjacentCards(board, bounds, pos)) {
        if (!n.faceUp) addDelta(n.instanceId, -2, `${CARD_DEFS.Truthseeker.name} (adjacent, face-down)`);
      }
    },
  },
  Mercenary: {
    id: "Mercenary",
    name: "Conciliator",
    base: 4,
    bucket: "Engine",
    text: "+1 per unique adj. enemy",
    fullText: "+1 for each distinct opposing player with a card adjacent to it.",
    count: [0, 0, 4, 4, 0, 0, 0],
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      const uniqueEnemyOwners = new Set(
        getAdjacentCards(board, bounds, pos)
          .filter((n) => n.ownerId !== self.ownerId)
          .map((n) => n.ownerId)
      ).size;
      if (uniqueEnemyOwners > 0) {
        addDelta(
          self.instanceId,
          1 * uniqueEnemyOwners,
          `${CARD_DEFS.Mercenary.name} (${uniqueEnemyOwners} unique adj. enem${uniqueEnemyOwners > 1 ? "ies" : "y"})`
        );
      }
    },
  },
  Beacon: {
    id: "Beacon",
    name: "Nightjar",
    base: 4,
    bucket: "Engine",
    text: "+1 per adj. matching own face state",
    fullText:
      "+1 for each adjacent card (any owner) whose face-up/face-down state matches this card's own.",
    count: [4, 4, 4, 4, 5, 6, 8],
    valueModifier: ({ board, bounds, pos, self, addDelta }) => {
      let matching = 0;
      for (const p of adjacentPositions(pos, bounds)) {
        const occupied = isOwnerlessPosition(p, bounds) || board.has(posKey(p));
        if (occupied && isPositionFaceUp(board, bounds, p) === self.faceUp) matching++;
      }
      if (matching > 0) addDelta(self.instanceId, matching, `${CARD_DEFS.Beacon.name} (${matching} adj. matching face state)`);
    },
  },
  PlagueRat: {
    id: "PlagueRat",
    name: "Plague Rat",
    base: 5,
    bucket: "Control",
    text: "Afflicts adj. cards with Plague",
    get fullText() {
      return `Applies Plague to each adjacent card (any owner). Plague: −1 to every afflicted card, and spreads from each afflicted card to every card of the same owner connected to it. Each card can only be afflicted once by the same ${CARD_DEFS.PlagueRat.name}.`
    },
    count: [2, 2, 2, 2, 3, 3, 4],
    valueModifier: ({ board, bounds, pos, addDelta }) => {
      const afflicted = new Set<string>();
      for (const seedPos of adjacentPositions(pos, bounds)) {
        const seed = board.get(posKey(seedPos));
        if (!seed || afflicted.has(seed.instanceId)) continue;
        const stack: Position[] = [seedPos];
        const visited = new Set<string>();
        while (stack.length > 0) {
          const curPos = stack.pop()!;
          const cur = board.get(posKey(curPos));
          if (!cur || visited.has(cur.instanceId)) continue;
          visited.add(cur.instanceId);
          afflicted.add(cur.instanceId);
          for (const nPos of adjacentPositions(curPos, bounds)) {
            const n = board.get(posKey(nPos));
            if (n && n.ownerId === seed.ownerId && !visited.has(n.instanceId)) stack.push(nPos);
          }
        }
      }
      for (const instanceId of afflicted) addDelta(instanceId, -1, `${CARD_DEFS.PlagueRat.name} (plague)`);
    },
  },
  Unknown: {
    id: "Unknown",
    name: "Unknown",
    // Roughly the deck-wide average base value -- a flat, effect-free stand-in for "an
    // opponent's face-down card I can't identify," not a real playable card. See the
    // CardId union in types.ts for why it exists and where it's used/excluded.
    base: 5.5,
    bucket: "Engine",
    text: "",
    fullText: "",
    count: flatCount(0),
    disabled: true,
  },
};

export const ALL_CARD_IDS: CardId[] = Object.keys(CARD_DEFS) as CardId[];
