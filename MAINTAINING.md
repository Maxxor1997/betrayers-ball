# Maintaining this repo

A practical guide to the file layout and the steps for common manual changes —
rebalancing/adding/removing cards, adding/changing center effects, and tuning other
game parameters. For the *rules* themselves (deck counts, scoring model, endgame), see
`game_spec.md`. For architecture rationale, see `board_game_design.md`.

## File structure

```
lib/
  engine/                 Pure game logic. No React, no UI concerns.
    types.ts              All shared types: CardId, CardDef, Board, GameState,
                           GameConfig, GameAction, CenterEffectId, etc.
    cards.ts              CARD_DEFS — the 17-card table: base value, bucket, text,
                           and deck copy count, all in one place per card.
    centerEffects.ts       CENTER_EFFECTS registry — one entry per center effect,
                           holding both its logic hooks and its UI label/description.
    board.ts               Board geometry: adjacency, bounds, position parsing.
    deck.ts                Deck building, shuffling, dealing, redrawing.
    resolution.ts          Scoring: per-card value modifiers (the big switch),
                           suppression, zeroing, floors, and center-effect hooks.
    turns.ts                Turn actions: place, flip, pass, and their legality
                            checks (including center-effect flip-gating).
    game.ts                 The reducer: applyAction(state, action) -> state.
                             Round/turn advancement, voting, game config by player
                             count.
    endgame.ts               End-of-game triggers, score computation, AI voting.
    playerView.ts             Redacts opponent face-down cards for fair AI evaluation.
    __tests__/                 Vitest specs, one file per module above.
  ai/
    randomAi.ts                Picks any legal action at random.
    greedyAi.ts                 Picks the action that maximizes estimated margin.
    __tests__/
  config/                        Pure tunable data with no logic attached.
    players.ts                   AI display names, player color palettes,
                                  min/max player count.
    boardSizing.ts                Board dimensions by player count.

app/
  play/
    page.tsx                      The single-device debug UI (client component).
    types.ts                      UI-local types (component props, popup state).
```

**Rule of thumb for where something lives:** if it's a plain value/table someone might
retune (numbers, text, names, colors), it goes in `lib/config/` or a `*_DEFS`/registry
table like `CARD_DEFS`/`CENTER_EFFECTS`. If it's behavior (a function that computes
something), it lives in `lib/engine/`. `centerEffects.ts` is the one place that
deliberately mixes both — each center effect's small hook functions live right next to
its label/description, because effects are the thing you're most likely to add later
and you want the whole effect in one spot.

## How to make common changes

### Rebalance an existing card (change base value or effect text)

1. Edit its entry in `lib/engine/cards.ts` (`CARD_DEFS`). Base value, bucket, `text`
   (short summary), `fullText` (tooltip), and `count` (deck copies) all live there.
2. If you only changed numbers/text, no other file needs touching — the AI and UI both
   read `CARD_DEFS` directly.
3. Run `npm run test` — `lib/engine/__tests__/deck.test.ts` asserts total deck size
   (72) and bucket totals (Slam 26 / Engine 25 / Control 21); if you changed `count`,
   update those assertions too (or the ones in `game_spec.md`'s deck table if that's
   meant to be the source of truth).

### Add a brand new card

1. Add the id to the `CardId` union in `lib/engine/types.ts`.
2. Add its entry to `CARD_DEFS` in `lib/engine/cards.ts` (base, bucket, text, fullText,
   count).
3. If it has a **scoring effect** (something that changes a card's value during
   resolution): add a `case "YourCard":` to the switch in `computeValueModifiers` in
   `lib/engine/resolution.ts`, following the pattern of existing cards (self-effects
   call `addDelta(c.instanceId, ...)`, outgoing effects call `addDelta(neighbor.instanceId, ...)`).
4. If it has a **placement/turn-time trigger** (like Giant's "always face-up" or
   Truthseeker's "flip all adjacent on placement"): add a check in `applyPlace` in
   `lib/engine/turns.ts`.
5. If it does neither (pure vanilla stat card), steps 1–2 are enough — no changes
   needed to the AI or UI, both are fully data-driven off `CARD_DEFS`.
6. Add tests: a resolution test in `lib/engine/__tests__/resolution.test.ts` for a
   scoring effect, or a turns test in `lib/engine/__tests__/turns.test.ts` for a
   placement trigger. Update the deck total/bucket-total assertions in
   `lib/engine/__tests__/deck.test.ts` if you added copies to the deck.

### Remove a card

Reverse of adding one: delete its `CARD_DEFS` entry, remove it from the `CardId`
union, delete any `case` in `resolution.ts`/check in `turns.ts`, delete its tests, and
update the deck-total assertions.

### Add a new center effect

1. Add the id to the `CenterEffectId` union in `lib/engine/types.ts`.
2. Add one entry to `CENTER_EFFECTS` in `lib/engine/centerEffects.ts` with:
   - `label` and `description` (the UI copy — `description` can be a function of
     `GameConfig` if the wording depends on player count, like Shadowlands does).
   - Whichever hooks the effect needs:
     - `valueModifiers` — extra per-card value deltas at scoring time (like No Man's
       Land, Mirror Pool).
     - `postResolution` — an award or zeroing pass computed from final totals (like
       Champion of the Weak, Kingslayer).
     - `flipGate` — overrides when flipping is allowed (like Shadowlands, Prying
       Eyes).
     - `flipTargetFilter` — restricts which face-down cards can be flip targets (like
       Prying Eyes).
     - `onRoundStart` — fires when a new round begins (like Reckoning).
   Leave a hook off if the effect doesn't need it.
3. That's it — `resolution.ts`, `turns.ts`, `game.ts`, and `app/play/page.tsx` all read
   the registry generically and don't need edits. `Record<CenterEffectId, CenterEffectDef>`
   means TypeScript will error if you forget to add the registry entry at all.
4. Add tests in the relevant `__tests__` file(s) depending on which hooks you used
   (`resolution.test.ts` for `valueModifiers`/`postResolution`, `turns.test.ts` for
   `flipGate`/`flipTargetFilter`, `game.test.ts` for `onRoundStart`).

### Change board sizing, player count bounds, or AI names/colors

- Board dimensions by player count: `lib/config/boardSizing.ts`
  (`BOARD_BOUNDS_BY_PLAYER_COUNT`).
- Min/max player count, AI display names, player color palettes:
  `lib/config/players.ts`.
- These are plain data — edit and re-run tests/build, no logic changes needed unless
  you're changing the *shape* of the data (e.g. adding a field), in which case update
  the type in `lib/engine/types.ts` and every call site that constructs one.

### Change turn/round/scoring rules that aren't card- or effect-specific

These are structural and touch the engine directly — there's no single table for them
since they're not "one entry per variant" the way cards/effects are:

- Round cap, hand size, min-round-floor (vote-eligibility), flip-unlock round:
  `configForPlayerCount()` in `lib/engine/game.ts`.
- Turn/round advancement, voting protocol: `advanceTurn`/`applyCastVote` in
  `lib/engine/game.ts`.
- Resolution order (suppression → value-modifiers → zeroing → floors): `resolveBoard`
  in `lib/engine/resolution.ts`.

## Commands to run after any change

```bash
npm run test        # full Vitest suite — run this after every change
npx tsc --noEmit     # typecheck (catches missing CENTER_EFFECTS/CARD_DEFS entries,
                     # since both are typed as Record<SomeUnion, ...>)
npm run build        # full Next.js build — also typechecks, plus catches
                      # anything tsc alone misses (route generation, etc.)
npm run dev           # then open /play and actually play a game through to the end,
                       # picking the effect/card you changed if applicable
```

For a card or effect change specifically, it's worth starting a game via "New game" in
the UI and picking that exact card/effect (or "Random" a few times) to confirm it
behaves as intended — the test suite covers correctness of the rule, not necessarily
that the UI surfaces it right (labels, tooltips, etc.).
