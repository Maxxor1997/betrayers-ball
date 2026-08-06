# Game Spec — Working Baseline v2 (4-player target)

> **⚠️ SNAPSHOT — not set in stone.** .

Everything here is a **config constant / parked tuning knob** unless flagged **LOCKED**. For game balance updates, you do not need to update this doc.

> **Numbers drift, code doesn't.** Card bases, effect deltas, and deck counts get hand-tuned directly in `lib/content/cards.ts` (and center effects in `lib/content/centerEffects.ts`) during playtesting. This doc does not track every such edit — treat any specific number below as a point-in-time illustration, not a current fact. `lib/content/cards.ts` / `lib/content/centerEffects.ts` are the source of truth; `lib/engine/__tests__/deck.test.ts` has the current deck totals.

---

## Core invariants (LOCKED)

- **Points live on cards only.** A player's score is the sum of the cards they own (`ownerId`). No effect awards points to a player directly — effects modify *cards*. (Champion of the Weak transfers a *card*, not points.)
- **Base value benchmark = Footman 5.** Any card better than a Footman pays for it with a sub-5 base or a real downside. (Chronicler is base 2 but its *effective* value scales past 5 with game length — a conditional payment rather than a flat stat penalty; see flag.)
- **Scoring is end-only, simultaneous, off base values.** Scoring-time effects read neighbors' base value + the card's own printed modifiers, positions, identities, ownership, or flip-state — **never** other cards' fully-resolved values. Keeps scoring loop-free.
- **Anything reading a *resolved* value runs as a post-resolution layer** (see two-phase scoring), never during the simultaneous pass.
- **Center = ownerless neighbor.** Counts as a real orthogonal neighbor for adjacency/trigger/penalty effects, belongs to no one, base 0 / not counted normally, not placeable-on. Owner checks skip it. Same ruling for any extra ownerless tile a location adds (e.g. Three Headed Dragon's heads).
- **Ownerless tiles are always face-up.** They hold no hidden info, so an effect that keys off a neighbor's face state (Pretender, PlagueBearer, ...) reads the center (and any extra ownerless tile) as face-up if it ever needs to.
- **Placement & effect adjacency: orthogonal only.** Every card placed face-to-face adjacent to an existing card, within the bounded box.

---

## The card set

Exact base values, effect text, and bucket assignments live in `lib/content/cards.ts`
(`CARD_DEFS`) — that's the source of truth, not this doc. 

## Parked tuning knobs (decide by playtest)

- **Mulligans** — build pure fixed-hand FIRST; add later (draw/discard, pass-a-card, or none).
- **Owner-dependent effects** — thread `ownerId` through scoring from day one even if unused.
- **Player-count-gated cards** — include `minPlayers`/`maxPlayers` on the card model, skip the logic for now.
- **Formation/set bonuses** — the Footman line is the first. If it plays well, opens a category (lines, blocks, patterns). Kept minimal (one card) for now.
- **Exact numbers** — min-round floor, turn cap, board W/H, hand size, all thresholds — constants, tuned by playing.
- **Final-tie-break rule** — NEEDS DECIDING (see endgame).

## Card ideas (in workshop)

- ~~Location: "Three Headed Dragon" 2 additional center blocks with no effect on the sides of the center with a gap, only for larger boards~~ **Implemented** (`lib/content/centerEffects.ts`) — not player-count-gated; the two extra heads sit 2 cells out along the center's row (1-cell gap) and are clipped if that would fall off a small board.
- ~~Infiltrator: rewards card itself for staying hidden but does some kind of sabotage~~ **Implemented** (`lib/content/cards.ts`, merged with the cut Headsman/Darkspawn) — while face-down, swaps base with the highest-base adjacent card; flipping it face-up is the counter.
- Card that immunes neighbors to being flipped?
- Card that rewards neiboring multiple players (only for larger groups)

# Feature backlog