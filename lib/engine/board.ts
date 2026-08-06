import { Board, BoardBounds, CardInstance, Position, posKey } from "./types";

const ORTHOGONAL_DELTAS: Position[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

export function inBounds(pos: Position, bounds: BoardBounds): boolean {
  return pos.x >= 0 && pos.x < bounds.width && pos.y >= 0 && pos.y < bounds.height;
}

export function isCenterPosition(pos: Position, bounds: BoardBounds): boolean {
  return pos.x === bounds.center.x && pos.y === bounds.center.y;
}

/**
 * True for any of the active center effect's ownerless tiles -- unplaceable, and
 * counts as an occupied neighbor for adjacency purposes. See `BoardBounds.ownerless`
 * (defaults to just the center tile).
 */
export function isOwnerlessPosition(pos: Position, bounds: BoardBounds): boolean {
  const ownerless = bounds.ownerless ?? [bounds.center];
  return ownerless.some((p) => p.x === pos.x && p.y === pos.y);
}

/** The 4 orthogonal neighbor positions, unfiltered (may be out of bounds). */
export function orthogonalPositions(pos: Position): Position[] {
  return ORTHOGONAL_DELTAS.map((d) => ({ x: pos.x + d.x, y: pos.y + d.y }));
}

/** In-bounds orthogonal neighbor positions. */
export function adjacentPositions(pos: Position, bounds: BoardBounds): Position[] {
  return orthogonalPositions(pos).filter((p) => inBounds(p, bounds));
}

/** Real placed cards orthogonally adjacent to `pos`. Center is never a CardInstance, so it's excluded here. */
export function getAdjacentCards(board: Board, bounds: BoardBounds, pos: Position): CardInstance[] {
  const cards: CardInstance[] = [];
  for (const p of adjacentPositions(pos, bounds)) {
    const card = board.get(posKey(p));
    if (card) cards.push(card);
  }
  return cards;
}

/**
 * Whether `pos` reads as "face-up" for an effect that keys off a neighbor's face
 * state (Pretender, ...). An ownerless tile (center,
 * or an extra tile like Three Headed Dragon's heads) is always face-up -- it holds no
 * hidden info, so there's nothing to be face-down about (see CLAUDE.md). Returns false
 * for an empty, non-ownerless cell -- there's no card there to be face-up or -down.
 */
export function isPositionFaceUp(board: Board, bounds: BoardBounds, pos: Position): boolean {
  if (isOwnerlessPosition(pos, bounds)) return true;
  return board.get(posKey(pos))?.faceUp ?? false;
}

/**
 * Count of orthogonally-adjacent cells that are "occupied" — a placed card, or an
 * ownerless tile (the center, or an extra tile like Three Headed Dragon's heads). Per
 * the locked core invariant, these are real neighbors for adjacency/trigger/penalty
 * purposes (e.g. Exile's per-neighbor penalty, Suppressor's 3+ trigger) even though
 * they hold no CardInstance and are never placed on.
 */
export function countAdjacentOccupied(board: Board, bounds: BoardBounds, pos: Position): number {
  let count = 0;
  for (const p of adjacentPositions(pos, bounds)) {
    if (isOwnerlessPosition(p, bounds) || board.has(posKey(p))) count++;
  }
  return count;
}

export function isAdjacentToCenter(pos: Position, bounds: BoardBounds): boolean {
  return adjacentPositions(pos, bounds).some((p) => isCenterPosition(p, bounds));
}

/**
 * Legal placement cells: empty, in bounds, not an ownerless tile (not placeable-on),
 * and orthogonally adjacent to an existing card OR an ownerless tile. On an empty
 * board the only legal cells are those adjacent to center — the "forced round-1
 * placement" the spec describes.
 *
 * `anywhere` (Freelands) drops the adjacency requirement entirely -- every empty,
 * non-ownerless cell is legal regardless of what's already on the board.
 */
export function getLegalPlacementPositions(board: Board, bounds: BoardBounds, opts: { anywhere?: boolean } = {}): Position[] {
  const legal: Position[] = [];
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const pos = { x, y };
      if (isOwnerlessPosition(pos, bounds)) continue;
      if (board.has(posKey(pos))) continue;
      if (opts.anywhere) {
        legal.push(pos);
        continue;
      }
      const hasOccupiedNeighbor = adjacentPositions(pos, bounds).some(
        (p) => isOwnerlessPosition(p, bounds) || board.has(posKey(p))
      );
      if (hasOccupiedNeighbor) legal.push(pos);
    }
  }
  return legal;
}

function parsePosKey(key: string): Position {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

/**
 * Whether the Footman at `pos` is part of a run of 3+ consecutive same-owner Footmen,
 * in its row or column. Identity/ownership only (not resolved values), so a negated
 * Footman still counts as a link for its neighbors' line even though it won't receive
 * its own bonus (that's gated separately, in resolution.ts).
 */
export function isInFootmanLine(board: Board, pos: Position, minLength = 3): boolean {
  const self = board.get(posKey(pos));
  if (!self || self.cardId !== "Footman") return false;

  const axes: Position[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];

  for (const axis of axes) {
    let length = 1;
    for (const dir of [1, -1]) {
      let cursor = { x: pos.x + axis.x * dir, y: pos.y + axis.y * dir };
      for (;;) {
        const card = board.get(posKey(cursor));
        if (!card || card.cardId !== "Footman" || card.ownerId !== self.ownerId) break;
        length++;
        cursor = { x: cursor.x + axis.x * dir, y: cursor.y + axis.y * dir };
      }
    }
    if (length >= minLength) return true;
  }
  return false;
}

export { posKey, parsePosKey };
