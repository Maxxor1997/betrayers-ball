import { CARD_DEFS } from "./cards";
import { countAdjacentOccupied, getAdjacentCards, isInFootmanLine, parsePosKey, posKey } from "./board";
import { Board, BoardBounds, CardId, CenterEffectId, Position } from "./types";

export interface ResolvedCard {
  instanceId: string;
  cardId: CardId;
  ownerId: string;
  position: Position;
  faceUp: boolean;
  baseValue: number;
  finalValue: number;
  negated: boolean;
}

export interface ResolutionResult {
  cards: ResolvedCard[];
  totalsByOwner: Record<string, number>;
  /** Champion of the Weak: who the center card went to and for how much, if anyone. */
  centerAward: { value: number; ownerId: string } | null;
  /** Kingslayer: instanceIds of the highest-value card(s), zeroed out. */
  kingslayerZeroed: string[];
}

/**
 * Step 1 — Suppression pass. Active Suppressors (3+ adjacent occupied cells, center
 * counts) negate adjacent non-Suppressor cards: their own modifiers and outgoing
 * effects are cancelled (base value only). Suppressors are immune to negation, and
 * two adjacent Suppressors never negate each other.
 */
function computeNegatedInstanceIds(board: Board, bounds: BoardBounds): Set<string> {
  const negated = new Set<string>();
  for (const [key, c] of board.entries()) {
    if (c.cardId !== "Suppressor") continue;
    const pos = parsePosKey(key);
    if (countAdjacentOccupied(board, bounds, pos) < 3) continue;
    for (const neighbor of getAdjacentCards(board, bounds, pos)) {
      if (neighbor.cardId !== "Suppressor") negated.add(neighbor.instanceId);
    }
  }
  return negated;
}

/**
 * Step 2 — Value-modifying pass. Every non-negated card's effect computes
 * simultaneously off base values, positions, identities, ownership, and flip-state —
 * never another card's resolved value. Effects are either "self" (the source card
 * modifies its own value, e.g. Commander) or "outgoing" (the source modifies
 * neighbors, e.g. Bannerman); both are skipped entirely if the source is negated.
 * Incoming effects still land on negated targets — negation only cancels a card's
 * own modifiers and outgoing effects, not its identity/base/flip-state as read by
 * others (a negated Footman still links its neighbors' line; a negated Warlord still
 * counts toward other Warlords' penalty).
 */
function computeValueModifiers(
  board: Board,
  bounds: BoardBounds,
  round: number,
  negated: Set<string>,
  centerEffect: CenterEffectId
): Map<string, number> {
  const deltas = new Map<string, number>();
  const addDelta = (instanceId: string, amount: number) => {
    deltas.set(instanceId, (deltas.get(instanceId) ?? 0) + amount);
  };

  for (const [key, c] of board.entries()) {
    if (negated.has(c.instanceId)) continue;
    const pos = parsePosKey(key);

    switch (c.cardId) {
      case "Footman": {
        if (isInFootmanLine(board, pos)) addDelta(c.instanceId, 1);
        break;
      }
      case "Warlord": {
        let otherWarlords = 0;
        for (const other of board.values()) {
          if (other.instanceId !== c.instanceId && other.cardId === "Warlord") otherWarlords++;
        }
        addDelta(c.instanceId, -3 * otherWarlords);
        break;
      }
      case "Exile": {
        addDelta(c.instanceId, -2 * countAdjacentOccupied(board, bounds, pos));
        break;
      }
      case "Pretender": {
        const dangerousNeighbor = getAdjacentCards(board, bounds, pos).some(
          (n) => n.faceUp && CARD_DEFS[n.cardId].base >= 7
        );
        if (dangerousNeighbor) addDelta(c.instanceId, -5);
        break;
      }
      case "Berserker": {
        let otherOwnerBerserkers = 0;
        for (const other of board.values()) {
          if (other.cardId === "Berserker" && other.ownerId !== c.ownerId) otherOwnerBerserkers++;
        }
        addDelta(c.instanceId, 2 * otherOwnerBerserkers);
        break;
      }
      case "Commander": {
        const adjFootmen = getAdjacentCards(board, bounds, pos).filter((n) => n.cardId === "Footman").length;
        addDelta(c.instanceId, 2 * adjFootmen);
        break;
      }
      case "Champion": {
        if (c.faceUp) addDelta(c.instanceId, 3);
        break;
      }
      case "Darkspawn": {
        const faceDownNeighbors = getAdjacentCards(board, bounds, pos).filter((n) => !n.faceUp).length;
        if (faceDownNeighbors >= 2) addDelta(c.instanceId, 5);
        break;
      }
      case "Chronicler": {
        addDelta(c.instanceId, round);
        break;
      }
      case "Earthshaker": {
        for (const [otherKey, other] of board.entries()) {
          if (other.instanceId === c.instanceId) continue;
          if (parsePosKey(otherKey).y === pos.y) addDelta(other.instanceId, -1);
        }
        break;
      }
      case "Skysplitter": {
        const above = board.get(posKey({ x: pos.x, y: pos.y - 1 }));
        const below = board.get(posKey({ x: pos.x, y: pos.y + 1 }));
        if (above) addDelta(above.instanceId, -3);
        if (below) addDelta(below.instanceId, -3);
        break;
      }
      case "Bannerman": {
        for (const n of getAdjacentCards(board, bounds, pos)) {
          addDelta(n.instanceId, n.cardId === "Footman" ? 2 : 1);
        }
        break;
      }
      case "Headsman": {
        for (const n of getAdjacentCards(board, bounds, pos)) {
          if (n.faceUp && CARD_DEFS[n.cardId].base >= 6) addDelta(n.instanceId, -4);
        }
        break;
      }
      // Giant, PlagueBearer, Suppressor: no value-modifying self/outgoing effect here.
      default:
        break;
    }
  }

  // Center-effect scoring-time passes. These are board rules, not printed card text,
  // so they apply regardless of negation.
  if (centerEffect === "noMansLand") {
    for (const [key, c] of board.entries()) {
      const pos = parsePosKey(key);
      if (pos.x === bounds.center.x || pos.y === bounds.center.y) addDelta(c.instanceId, -2);
    }
  }

  if (centerEffect === "mirrorPool") {
    for (const [key, c] of board.entries()) {
      const pos = parsePosKey(key);
      const mirrorPos = { x: pos.x, y: 2 * bounds.center.y - pos.y };
      if (mirrorPos.y === pos.y) continue; // on the center row itself -- no distinct mirror
      const mirrorCard = board.get(posKey(mirrorPos));
      if (mirrorCard) addDelta(c.instanceId, mirrorCard.cardId === c.cardId ? 2 : 1);
    }
  }

  return deltas;
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

/** Step 3 — Zeroing pass. A non-negated Plague Bearer with 2+ adjacent Footmen zeroes those Footmen. */
function applyZeroingPass(board: Board, bounds: BoardBounds, negated: Set<string>, values: Map<string, number>): void {
  for (const [key, c] of board.entries()) {
    if (c.cardId !== "PlagueBearer" || negated.has(c.instanceId)) continue;
    const pos = parsePosKey(key);
    const adjacentFootmen = getAdjacentCards(board, bounds, pos).filter((n) => n.cardId === "Footman");
    if (adjacentFootmen.length >= 2) {
      for (const footman of adjacentFootmen) values.set(footman.instanceId, 0);
    }
  }
}

/** Step 4 — Floors. Warlord and Exile floor at 0. */
function applyFloors(board: Board, values: Map<string, number>): void {
  for (const c of board.values()) {
    if (c.cardId !== "Warlord" && c.cardId !== "Exile") continue;
    const v = values.get(c.instanceId) ?? 0;
    if (v < 0) values.set(c.instanceId, 0);
  }
}

/**
 * Runs the full spec resolution order (suppression -> value-modifying -> zeroing ->
 * floors -> freeze -> post-resolution) and returns each card's frozen final value plus
 * per-owner totals. `round` is the global round the game ended on (feeds Chronicler).
 *
 * `centerEffect` and `playerIds` are optional and default to the pre-center-effects
 * behavior (`"none"`, totals built only from owners who placed a card) so existing
 * callers are unaffected. Pass `playerIds` when using `championOfTheWeak` so a player
 * with zero cards can still be the unique last place.
 */
export function resolveBoard(
  board: Board,
  bounds: BoardBounds,
  round: number,
  centerEffect: CenterEffectId = "none",
  playerIds?: string[]
): ResolutionResult {
  const negated = computeNegatedInstanceIds(board, bounds);
  const deltas = computeValueModifiers(board, bounds, round, negated, centerEffect);

  const values = new Map<string, number>();
  for (const c of board.values()) {
    values.set(c.instanceId, CARD_DEFS[c.cardId].base + (deltas.get(c.instanceId) ?? 0));
  }

  applyZeroingPass(board, bounds, negated, values);
  applyFloors(board, values);

  const cards: ResolvedCard[] = [];
  const totalsByOwner: Record<string, number> = {};
  if (playerIds) for (const id of playerIds) totalsByOwner[id] = 0;

  for (const [key, c] of board.entries()) {
    const finalValue = values.get(c.instanceId) ?? CARD_DEFS[c.cardId].base;
    cards.push({
      instanceId: c.instanceId,
      cardId: c.cardId,
      ownerId: c.ownerId,
      position: parsePosKey(key),
      faceUp: c.faceUp,
      baseValue: CARD_DEFS[c.cardId].base,
      finalValue,
      negated: negated.has(c.instanceId),
    });
    totalsByOwner[c.ownerId] = (totalsByOwner[c.ownerId] ?? 0) + finalValue;
  }

  const kingslayerZeroed: string[] = [];
  if (centerEffect === "kingslayer" && cards.length > 0) {
    const maxValue = Math.max(...cards.map((c) => c.finalValue));
    for (const c of cards) {
      if (c.finalValue === maxValue) {
        totalsByOwner[c.ownerId] = (totalsByOwner[c.ownerId] ?? 0) - c.finalValue;
        c.finalValue = 0;
        kingslayerZeroed.push(c.instanceId);
      }
    }
  }

  let centerAward: { value: number; ownerId: string } | null = null;
  if (centerEffect === "championOfTheWeak") {
    const centerValue = 5 + computeCenterModifier(board, bounds, negated);
    const ids = playerIds ?? Object.keys(totalsByOwner);
    if (ids.length > 0) {
      const minTotal = Math.min(...ids.map((id) => totalsByOwner[id] ?? 0));
      const lowest = ids.filter((id) => (totalsByOwner[id] ?? 0) === minTotal);
      if (lowest.length === 1) {
        const ownerId = lowest[0];
        totalsByOwner[ownerId] = (totalsByOwner[ownerId] ?? 0) + centerValue;
        centerAward = { value: centerValue, ownerId };
      }
    }
  }

  return { cards, totalsByOwner, centerAward, kingslayerZeroed };
}
