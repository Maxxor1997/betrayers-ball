# Maintaining this repo

A practical guide to the file layout and the steps for common manual changes —
rebalancing/adding/removing cards, adding/changing center effects, and tuning other
game parameters. For the *rules* themselves (deck counts, scoring model, endgame), see
`game_spec.md`. For architecture rationale, see `board_game_design.md`.

## File structure

```
lib/
  engine/                 Pure game mechanics. Knows *how* the game runs, not what any
                          particular card or center effect does.
    types.ts              Shared types: CardId, Board, GameState, GameConfig,
                           GameAction, CenterEffectId, etc.
    board.ts              Board geometry: adjacency, bounds, position parsing.
    deck.ts                Deck building, shuffling, dealing, redrawing.
    resolution.ts          The resolution pipeline: suppression -> per-card hooks ->
                            zeroing -> floors -> center-effect hooks. Generic — it
                            calls into whatever hooks lib/content/cards.ts and
                            lib/content/centerEffects.ts define, and has no
                            card-specific or effect-specific logic of its own.
    turns.ts                Turn actions: place, flip, pass, and their legality
                            checks — also generic, calling into content hooks.
    game.ts                 The reducer: applyAction(state, action) -> state.
                             Round/turn advancement, voting, game config by player
                             count.
    endgame.ts               End-of-game triggers, score computation, AI voting.
    playerView.ts             Redacts opponent face-down cards for fair AI evaluation.
    __tests__/                 Vitest specs, one file per module above.
  content/                      Game *content* — the actual cards and center effects,
                                 each fully self-contained (stats/text + its own logic
                                 hooks). This is almost always the only folder you need
                                 to touch to rebalance, add, or remove something.
    cards.ts                     CARD_DEFS — one entry per card: base value, bucket,
                                  text, deck count, and its effect as one or more hook
                                  functions (see below).
    centerEffects.ts              CENTER_EFFECTS — one entry per center effect: label,
                                   description, and its logic as hook functions.
  ai/
    randomAi.ts                Picks any legal action at random.
    greedyAi.ts                 Picks the action that maximizes estimated margin.
    __tests__/
  config/                        Pure tunable data with no logic attached — not game
                                  content, just app-level constants.
    players.ts                   AI display names, player color palettes,
                                  min/max player count.
    boardSizing.ts                Board dimensions by player count.

app/
  play/
    page.tsx                      The single-device debug UI (client component).
    types.ts                      UI-local types (component props, popup state).
```

**Rule of thumb for where something lives:** a specific card or center effect's stats,
text, and *behavior* all live together in `lib/content/`. `lib/engine/` only knows the
generic shapes of those hooks (a "value modifier," a "flip gate") and calls them — it
never mentions a card or effect by name. `lib/config/` is for plain data that isn't
"game content" (display names, colors, board size).

## How per-card and per-effect hooks work

Every card in `CARD_DEFS` (`lib/content/cards.ts`) and every effect in
`CENTER_EFFECTS` (`lib/content/centerEffects.ts`) can define its logic as small hook
functions right inside its own entry — there's no shared switch statement to also go
find and edit. A card with no printed effect just omits every hook; a card with a
scoring effect defines `valueModifier`; and so on. The hook shapes available today
(see the `CardDef`/`CenterEffectDef` interfaces at the top of each file for exact
signatures):

**Cards** (`lib/content/cards.ts`):
- `forceFaceUp` — always face-up when placed (Giant). Plain data, not a function.
- `floorAtZero` — value floors at 0 after modifiers (Warlord, Exile). Plain data.
- `valueModifier(ctx)` — the card's scoring effect; call `ctx.addDelta(instanceId, n)`
  on itself or a neighbor (most cards with printed text: Footman, Bannerman, etc.).
- `negatesNeighborsIf(ctx)` — returns whether this card should negate its neighbors
  right now (Suppressor).
- `zeroesAdjacentIf(ctx)` — returns instanceIds of adjacent cards to zero out
  (Plague Bearer).
- `onPlace(ctx)` — a placement-time trigger that can mutate the board directly, for
  effects that aren't about scoring (Truthseeker's flip-all-adjacent).

**Center effects** (`lib/content/centerEffects.ts`):
- `label`, `description` — UI copy (`description` can be a function of `GameConfig`
  for effects whose wording depends on player count, like Shadowlands).
- `valueModifiers(board, bounds, addDelta)` — extra per-card deltas at scoring time
  (No Man's Land, Mirror Pool).
- `postResolution(ctx)` — an award or zeroing pass off final totals (Champion of the
  Weak, Kingslayer).
- `flipGate(round, config)` — overrides whether flipping is allowed (Shadowlands,
  Prying Eyes).
- `flipTargetFilter(targets, playerId)` — restricts which face-down cards are legal
  flip targets (Prying Eyes).
- `onRoundStart(state, newRound, rng)` — fires when a new round begins (Reckoning).

`lib/engine/resolution.ts` and `lib/engine/turns.ts` only ever do generic
`CARD_DEFS[cardId].someHook?.(...)` / `CENTER_EFFECTS[id].someHook?.(...)` lookups —
they don't change when you add a card or effect, *unless* it needs a hook shape that
doesn't exist yet (see "Adding a genuinely new mechanic" below).

## How to make common changes

### Rebalance an existing card (change base value, effect text, or deck count)

1. Edit its entry in `lib/content/cards.ts` (`CARD_DEFS`). Base value, bucket, `text`
   (short summary), and `fullText` (tooltip) are plain fields.
2. `count` is an array of copy counts, one per supported player count (index 0 =
   `MIN_PLAYERS`, last index = `MAX_PLAYERS` — see the doc comment on `CardDef.count`).
   Most cards use `flatCount(n)` for a count that doesn't vary by player count; to make
   a card scale with player count, replace that with an explicit array, e.g.
   `count: [10, 10, 12, 12, 14, 14, 16]` for 2p through 8p. Use
   `copiesForPlayerCount(def, playerCount)` (exported from `cards.ts`) rather than
   indexing `count` by hand anywhere else in the code.
3. To pull a card out of the deck entirely (at every player count) without deleting
   its definition or touching its `count` array, set `disabled: true` on its entry —
   it overrides `count` unconditionally. Useful for temporarily benching a card during
   balance testing.
4. If you only changed numbers/text, no other file needs touching — the AI and UI both
   read `CARD_DEFS` directly, and `buildDeck(playerCount)` reads `count`/`disabled`
   generically.
5. Run `npm run test` — `lib/engine/__tests__/deck.test.ts` asserts, at every
   supported player count, that the deck matches each card's `copiesForPlayerCount`
   and that the 2p bucket totals match spec (Slam 26 / Engine 25 / Control 21). If you
   changed counts, update those assertions too (or `game_spec.md`'s deck table if
   that's meant to be the source of truth).

### Add a brand new card

1. Add the id to the `CardId` union in `lib/engine/types.ts`.
2. Add its entry to `CARD_DEFS` in `lib/content/cards.ts` (base, bucket, text,
   fullText, and a `count` array — usually `flatCount(n)`), plus whichever hook(s) its
   effect needs (see above) — e.g. a scoring effect gets `valueModifier`, a placement
   trigger gets `onPlace`.
3. If it's a pure vanilla stat card (no hooks), steps 1–2 are enough — no changes
   needed to the engine, AI, or UI; all are fully data-driven off `CARD_DEFS`.
4. Add tests: a resolution test in `lib/engine/__tests__/resolution.test.ts` for a
   `valueModifier`/`negatesNeighborsIf`/`zeroesAdjacentIf` hook, or a turns test in
   `lib/engine/__tests__/turns.test.ts` for `forceFaceUp`/`onPlace`. Update the deck
   total/bucket-total assertions in `lib/engine/__tests__/deck.test.ts` if you added
   copies to the deck.

### Remove a card

Reverse of adding one: delete its `CARD_DEFS` entry, remove it from the `CardId`
union, delete its tests, and update the deck-total assertions. (For a *temporary*
removal, prefer `disabled: true` over deleting the entry — see above.)

### Add a new center effect

1. Add the id to the `CenterEffectId` union in `lib/engine/types.ts`.
2. Add one entry to `CENTER_EFFECTS` in `lib/content/centerEffects.ts` with `label`,
   `description`, and whichever hooks it needs (see above). Leave a hook off if the
   effect doesn't need it.
3. If the effect should only be available at certain player counts (e.g. a "location"
   effect that only makes sense on larger boards), set `minPlayerCount` and/or
   `maxPlayerCount` on the entry — it'll drop out of the New Game popup's dropdown and
   the "Random" draw below/above those player counts. Omit both for an effect
   available at every supported player count (the default).
4. To pull an effect out of both the picker and the random draw entirely (at every
   player count) without deleting its entry or touching `minPlayerCount`/
   `maxPlayerCount`, set `disabled: true` — it overrides both unconditionally. Useful
   for temporarily benching an effect, same as a card's `disabled` field (see above).
5. That's it — `resolution.ts`, `turns.ts`, `game.ts`, and `app/play/page.tsx` all read
   the registry generically (via `selectableCenterEffects(playerCount)` /
   `randomCenterEffectPool(playerCount)` / `isAvailableAtPlayerCount()`) and don't need
   edits. `Record<CenterEffectId, CenterEffectDef>` means TypeScript will error if you
   forget to add the registry entry at all.
6. Add tests in the relevant `__tests__` file(s) depending on which hooks you used
   (`resolution.test.ts` for `valueModifiers`/`postResolution`, `turns.test.ts` for
   `flipGate`/`flipTargetFilter`, `game.test.ts` for `onRoundStart`,
   `lib/content/__tests__/centerEffects.test.ts` for `minPlayerCount`/`maxPlayerCount`/
   `disabled` gating).

### Adding a genuinely new mechanic (a hook shape that doesn't exist yet)

If a card or effect needs something none of the existing hooks cover (e.g. a card that
reacts to another card being flipped, not just placed), you'll need to:
1. Add the new hook's signature to `CardDef`/`CenterEffectDef` in `lib/content/cards.ts`
   / `lib/content/centerEffects.ts`.
2. Call it from the right spot in `lib/engine/resolution.ts` or `lib/engine/turns.ts`
   (generically, keyed off `cardId`/`centerEffect` — not a card-specific branch).
3. Only then does adding the card/effect itself go back to being a one-file change.

### Change board sizing, player count bounds, or AI names/colors

- Board dimensions by player count: `lib/config/boardSizing.ts`
  (`BOARD_SIZE_BY_PLAYER_COUNT`) — currently defines 2p through 8p (`MAX_PLAYERS`).
  Only `width`/`height` are configured; the center tile position is always derived
  from them (`makeBoardBounds()`) as the true middle, rounding down on an even axis —
  there's no `center` field to hand-edit or accidentally desync from the dimensions.
- Min/max player count, AI display names, player color palettes:
  `lib/config/players.ts`.
- These are plain data — edit and re-run tests/build, no logic changes needed unless
  you're changing the *shape* of the data (e.g. adding a field), in which case update
  the type in `lib/engine/types.ts` and every call site that constructs one.
- **Raising `MAX_PLAYERS` further:** add a matching `{ width, height }` entry to
  `BOARD_SIZE_BY_PLAYER_COUNT` (`configForPlayerCount()` in `lib/engine/game.ts`
  throws if a player count has none), and extend `AI_NAMES`/`PLAYER_COLOR_CLASSES`/
  `PLAYER_TEXT_COLOR_CLASSES`/`PLAYER_BORDER_COLOR_CLASSES` in `lib/config/players.ts`
  so the new player slots get real names/colors instead of falling back to generic
  ones. Every `CARD_DEFS[...].count` array also needs another entry (or just rebuild
  it with `flatCount(n)`, which sizes itself off `MAX_PLAYERS` automatically).

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
