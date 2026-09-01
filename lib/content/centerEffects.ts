import { getAdjacentCards, inBounds, parsePosKey, posKey } from "@/lib/engine/board";
import { CARD_DEFS } from "@/lib/content/cards";
import { Rng } from "@/lib/engine/deck";
import { computeSyntheticCardContributions, FLOORED_AT_ZERO_LABEL, type ResolvedCard, type ScoreContribution } from "@/lib/engine/resolution";
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
   * Kingslayer only: the printed base a face-down Facestealer/Infiltrator should treat
   * the center as, when comparing it against its other adjacent face-up candidates for
   * its swap (see resolution.ts's computeIdentitySwaps). Undefined everywhere else --
   * an ownerless tile with no real, swappable value of its own is simply never a
   * candidate.
   */
  facestealerCandidateBase?: number;

  /**
   * Post-resolution award/zeroing off final totals. May mutate `cards`/`totalsByOwner`
   * in place (e.g. zeroing a card's finalValue); returned fields become part of the
   * ResolutionResult.
   */
  postResolution?: (ctx: {
    board: Board;
    bounds: BoardBounds;
    round: number;
    negated: Set<string>;
    cards: ResolvedCard[];
    totalsByOwner: Record<string, number>;
    playerIds?: string[];
    /** instanceIds of any face-down Facestealer(s) that won the center as their swap target instead of a real neighbor -- see facestealerCandidateBase. */
    centerSwaps: Set<string>;
  }) => { kingslayerHit?: string[]; kingslayerCard?: ResolvedCard };

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
  ownerlessPositions?: (bounds: BoardBounds, rng: Rng) => Position[];
  /** UI label shown on each ownerless tile when set. Defaults to `label`. */
  ownerlessLabel?: string;

  /** Drops the normal adjacency requirement -- any empty, non-ownerless cell is a legal placement. */
  placementAnywhere?: boolean;
}

/**
 * Base "value" of the Kingslayer pseudo-card, before any adjacency contributions --
 * exported so tests can compute expected totals from this instead of duplicating the
 * literal.
 */
export const KINGSLAYER_BASE_VALUE = 5;

/**
 * Fixed instanceId/ownerId for Kingslayer's synthetic center "card" -- see
 * computeSyntheticCardContributions and the `kingslayer` postResolution hook below.
 * Never appears in a real GameState/board -- only ever constructed transiently, for
 * the one game (Kingslayer) that needs it, and returned separately as
 * ResolutionResult.kingslayerCard, never folded into `cards`/`totalsByOwner`.
 * KINGSLAYER_OWNER_ID never collides with a real seat id (those are always `p${n}`/
 * `ai-${n}`), and nothing reads it as a real player -- see this file's own doc
 * comment on why this stays a display-only, scoring-time fiction rather than a real
 * extra seat.
 */
export const KINGSLAYER_INSTANCE_ID = "__kingslayer_center__";
const KINGSLAYER_OWNER_ID = "__kingslayer__";


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
    ownerlessLabel: "Pool",
    ownerlessPositions: (bounds) => {
      const { x } = bounds.center;
      return [{ x, y: 0 }, { x, y: bounds.height - 1 }];
    },
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
    ownerlessLabel: "Ruin",
    // The 4 diagonal corners of the 3x3 block surrounding center, not out at the
    // edges -- right where round-1's forced placement pushes everyone first, so
    // there are fewer real neighbor slots to go around in the exact area where
    // players collide earliest. Center's own 4 orthogonal neighbors stay real and
    // placeable (it isn't boxed off), but a card placed there now has fewer full
    // rings of open cells to build an all-ally pocket in -- more forced
    // opposing-owner adjacency nearby, not less.
    ownerlessPositions: (bounds) => {
      const { x, y } = bounds.center;
      return [
        { x: x - 1, y: y - 1 },
        { x: x + 1, y: y - 1 },
        { x: x - 1, y: y + 1 },
        { x: x + 1, y: y + 1 },
      ].filter((p) => inBounds(p, bounds));
    },
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
    description:
      "At the end of the game, each player's single lowest-valued card is worth double (a tie is broken by whichever was placed last).",
    ownerlessLabel: "Ward",
    ownerlessPositions: (bounds, rng) =>
      rng() < 0.5
        ? [
            { x: 0, y: 0 },
            { x: bounds.width - 1, y: bounds.height - 1 },
          ]
        : [
            { x: bounds.width - 1, y: 0 },
            { x: 0, y: bounds.height - 1 },
          ],
    postResolution: ({ cards, totalsByOwner }) => {
      const byOwner = new Map<string, ResolvedCard[]>();
      for (const c of cards) {
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
        lowest.breakdown.push({ label: `${CENTER_EFFECTS.championOfTheWeak.label} (lowest value, doubled)`, amount: bonus, source: "external" });
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
    description:
      "At the end of the game, each player's single highest-valued face-up card is worth double (a tie is broken by whichever was placed last).",
    ownerlessLabel: "Gate",
    // No ownerlessPositions override -- a single gate sits on the default center
    // tile, same as most other locations, rather than two flanking tiles either
    // side of a real, placeable center.
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
    description:
      "On each of your turns, you may only place one of 3 random, unique cards offered from your hand (equal odds each) -- a fresh offer is drawn once the previous one is used.",
    ownerlessLabel: "Pillar",
    ownerlessPositions: (bounds) => {
      const { x, y } = bounds.center;
      return [
        { x: x - 2, y },
        { x, y },
        { x: x + 2, y },
      ].filter((p) => inBounds(p, bounds));
    },
  },

  threeHeadedDragon: {
    label: "Corpse of the Great Wyrm",
    themeColorClass: "text-fuchsia-700 dark:text-fuchsia-500",
    titleHighlight: "Wyrm",
    description: "Any card adjacent to any of the three heads gains +1.",
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
    disabled: true,
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
    ownerlessLabel: "City",
    ownerlessPositions: (bounds, rng) => {
      // Tunable: 1 tile at 2p/3p board sizes, 2 at 4p/5p, 3 at 6p/7p, 4 at 8p.
      const count = Math.max(1, Math.round((bounds.width * bounds.height) / 30));
      const all: Position[] = [];
      for (let x = 0; x < bounds.width; x++) {
        for (let y = 0; y < bounds.height; y++) all.push({ x, y });
      }
      // Fisher-Yates partial shuffle, driven by the passed rng so this is reproducible
      // under a seeded rng (tests, replay) and genuinely random otherwise.
      for (let i = all.length - 1; i > all.length - 1 - count && i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      return all.slice(all.length - count);
    },
    placementAnywhere: true,
  },

  borderlands: {
    label: "The Frontier",
    themeColorClass: "text-stone-700 dark:text-stone-400",
    titleHighlight: "Frontier",
    ownerlessLabel: "Outpost",
    description: "Cards on the board's edge gain +1. Cards in a corner instead gain +2 (flat, not stacked with the edge bonus).",
    valueModifiers: (board, bounds, addDelta) => {
      for (const [key, c] of board.entries()) {
        const pos = parsePosKey(key);
        const onEdge = pos.x === 0 || pos.y === 0 || pos.x === bounds.width - 1 || pos.y === bounds.height - 1;
        if (!onEdge) continue;
        const onCorner = (pos.x === 0 || pos.x === bounds.width - 1) && (pos.y === 0 || pos.y === bounds.height - 1);
        addDelta(c.instanceId, onCorner ? 2 : 1, CENTER_EFFECTS.borderlands.label);
      }
    },
  },

  noMansLand: {
    label: "No Man's Land",
    themeColorClass: "text-neutral-700 dark:text-neutral-400",
    titleHighlight: "No Man's Land",
    description: "Any card on the center's row or column takes -2.",
    ownerlessLabel: "Trench",
    ownerlessPositions: (bounds) => [
      { x: 0, y: 0 },
      { x: bounds.width - 1, y: 0 },
      { x: 0, y: bounds.height - 1 },
      { x: bounds.width - 1, y: bounds.height - 1 },
    ],
    valueModifiers: (board, bounds, addDelta) => {
      const { x, y } = bounds.center;
      for (const [key, c] of board.entries()) {
        const pos = parsePosKey(key);
        if (pos.x === x || pos.y === y) addDelta(c.instanceId, -2, CENTER_EFFECTS.noMansLand.label);
      }
    },
  },

  kingslayer: {
    label: "Kingslayer's Court",
    themeColorClass: "text-red-700 dark:text-red-500",
    titleHighlight: "Kingslayer's",
    // The board tile itself just says "Kingslayer" -- "Kingslayer's Court" is the
    // location's full name (catalog, New Game picker), too long to sit on the tile.
    ownerlessLabel: "Kingslayer",
    // A face-down Facestealer/Infiltrator can target the center as its swap
    // candidate too, same as any real card -- see resolution.ts's
    // computeIdentitySwaps.
    facestealerCandidateBase: KINGSLAYER_BASE_VALUE,
    description: `Kingslayer counts as a card worth ${KINGSLAYER_BASE_VALUE}. After scoring, its value is subtracted from the highest-value card(s) on the board -- tied cards all get hit.`,
    postResolution: ({ board, bounds, round, cards, totalsByOwner, centerSwaps }) => {
      const cardNameByInstanceId = new Map(Array.from(board.values(), (c) => [c.instanceId, CARD_DEFS[c.cardId].name]));

      // A face-down Facestealer that won the center as its swap target scores AS
      // Kingslayer FROM ITS OWN POSITION -- same "the borrowed rule runs from the
      // thief's own spot" precedent a real swap follows (see applyIdentitySwaps'
      // own doc comment) -- while the true center itself scores as a plain
      // Infiltrator instead (below). Multiple Facestealers can each independently
      // win it, same as a real target.
      for (const instanceId of centerSwaps) {
        const entry = Array.from(board.entries()).find(([, c]) => c.instanceId === instanceId);
        if (!entry) continue;
        const [key, thief] = entry;
        const synthetic: CardInstance = { instanceId, cardId: "Unknown", ownerId: thief.ownerId, faceUp: true };
        const { contributions } = computeSyntheticCardContributions(board, bounds, round, "kingslayer", parsePosKey(key), synthetic);
        const breakdown: ScoreContribution[] = [{ label: "Scoring as Kingslayer (Facestealer effect)", amount: 0, source: "self" }];
        breakdown.push({ label: "Base", amount: KINGSLAYER_BASE_VALUE, source: "self" });
        breakdown.push(...contributions);
        const rawTotal = KINGSLAYER_BASE_VALUE + contributions.reduce((sum, d) => sum + (d.informational ? 0 : d.amount), 0);
        const finalValue = Math.max(0, rawTotal);
        if (finalValue !== rawTotal) breakdown.push({ label: FLOORED_AT_ZERO_LABEL, amount: finalValue - rawTotal, source: "self" });

        const resolved = cards.find((c) => c.instanceId === instanceId);
        if (!resolved) continue;
        totalsByOwner[resolved.ownerId] = (totalsByOwner[resolved.ownerId] ?? 0) + (finalValue - resolved.finalValue);
        resolved.finalValue = finalValue;
        resolved.breakdown = breakdown;
      }

      // Treated as a genuine card for scoring purposes -- see
      // computeSyntheticCardContributions's own doc comment for why this is computed
      // as an isolated, throwaway side calculation rather than a real extra board
      // entry/player (it would otherwise hand real points to e.g. an adjacent
      // Mercenary for "an extra adjacent enemy"). If a Facestealer won it above, the
      // center itself now scores as a plain Infiltrator instead -- same "the target
      // loses its own identity/rule" precedent a real swap follows -- though incoming
      // effects from its neighbors still land exactly as they would on any other
      // scoring-as-Infiltrator target.
      const swappedAway = centerSwaps.size > 0;
      const centerBaseValue = swappedAway ? CARD_DEFS.Infiltrator.base : KINGSLAYER_BASE_VALUE;
      const synthetic: CardInstance = { instanceId: KINGSLAYER_INSTANCE_ID, cardId: "Unknown", ownerId: KINGSLAYER_OWNER_ID, faceUp: true };
      const { contributions, negatedBy } = computeSyntheticCardContributions(board, bounds, round, "kingslayer", bounds.center, synthetic);

      const breakdown: ScoreContribution[] = [];
      if (swappedAway) breakdown.push({ label: `Scoring as ${CARD_DEFS.Infiltrator.name} (Facestealer effect)`, amount: 0, source: "self" });
      if (negatedBy.length > 0) {
        const negatorNames = negatedBy.map((id) => cardNameByInstanceId.get(id) ?? "negation");
        breakdown.push({ label: `Negated by ${negatorNames.join(", ")}`, amount: 0, source: "self" });
      }
      breakdown.push({ label: "Base", amount: centerBaseValue, source: "self" });
      breakdown.push(...contributions);
      const rawTotal = centerBaseValue + contributions.reduce((sum, d) => sum + (d.informational ? 0 : d.amount), 0);
      // Same universal "never scores negative" floor every real card's own value gets.
      const kingslayerValue = Math.max(0, rawTotal);
      if (kingslayerValue !== rawTotal) breakdown.push({ label: FLOORED_AT_ZERO_LABEL, amount: kingslayerValue - rawTotal, source: "self" });

      const kingslayerCard: ResolvedCard = {
        instanceId: KINGSLAYER_INSTANCE_ID,
        cardId: "Unknown",
        ownerId: KINGSLAYER_OWNER_ID,
        position: bounds.center,
        faceUp: true,
        baseValue: centerBaseValue,
        finalValue: kingslayerValue,
        negated: negatedBy.length > 0,
        breakdown,
      };

      if (cards.length === 0) return { kingslayerCard };
      // Lictor/Suppressor negating Kingslayer cancels its own printed rule -- the
      // steal ability -- same as it would for any other card's rule; its tracked
      // value above still updates normally (negation only ever cancels a target's own
      // outgoing/self effects, never what neighbors still do to it -- see
      // resolution.ts's own doc comment on this).
      if (negatedBy.length > 0) return { kingslayerCard };

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
      return { kingslayerHit, kingslayerCard };
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
