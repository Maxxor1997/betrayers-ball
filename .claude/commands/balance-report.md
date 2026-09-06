---
description: Run bulk AI-vs-AI simulation batches and publish a "Location Report"-style balance report artifact — per-card balance scores and per-location best/worst breakdowns, grounded in real numbers and real card/location text
---

Produces a report like the "Location Report" artifact this command was modeled on:
a per-card balance-score grid (sortable, with a hover heat-strip of that card's
Placement Δ at every location) plus a per-location grid (best/worst card there, with a
strip of every tracked card at that location, best → worst). Every insight is
hand-written from the actual numbers and the actual printed card/location rules — never
templated filler.

Default args if the user doesn't specify otherwise: **200 games per player count, at
"expert" difficulty, for player counts 4 and 8**. If the user asks for different
numbers (a different game count, difficulty, or player count list), use those instead
— everything below still applies, just with the new numbers substituted in.

## 1. Run the simulation batches

`lib/playtest/scripts/runBalanceBatch.ts` is a headless CLI runner (no browser, no
React) that plays full AI-vs-AI games using the same engine/AI functions a real game
uses, at whatever player count/difficulty/game count you ask for, with locations drawn
randomly from `randomCenterEffectPool` and tagged per game so a per-location breakdown
falls out for free (`PlaytestStats.byCenterEffect`). Unlike `cardStats.ts`'s own
`simulateOneGame`, it wires `computeVoteForDifficulty` into `applyAction`'s real vote
parameter, so round-boundary votes at "expert" get genuine `chooseExpertVote` search
behavior, not the plain heuristic every difficulty falls back to there. See the
script's own doc comment for the full reasoning.

Run one batch per requested player count:

```
npx tsx lib/playtest/scripts/runBalanceBatch.ts --players=4 --games=200 --difficulty=expert --out=<scratchpad>/balance-4p.json --seed=42
npx tsx lib/playtest/scripts/runBalanceBatch.ts --players=8 --games=200 --difficulty=expert --out=<scratchpad>/balance-8p.json --seed=42
```

Write output to this session's scratchpad directory, not `/tmp` directly. Pick a fixed
`--seed` (any integer) so the run is reproducible if you need to re-derive or spot-check
a number later.

**Timing**: expert's real search budget is 200ms/70 candidates per decision (see
`DEFAULT_HARD_FAST_OPTIONS` in `lib/ai/hardFast.ts`) — this is genuinely slow, not a
quick script. Measured on this machine: ~5.7s/game at 4p, ~8.5s/game at 8p, so 200
games is roughly 19 minutes at 4p and 28 minutes at 8p. Before committing to a full
run:
- Smoke-test with `--games=2` or `--games=3` first to confirm it runs and to re-measure
  timing on whatever machine you're actually running on (it varies with CPU).
- Launch each requested player count's real batch as a separate background command
  (`run_in_background`) so they run in parallel rather than one after another — total
  wall time then tracks whichever player count's batch is slowest, not the sum of all
  of them.
- Tell the user roughly how long this will take before you start it, since it's long
  enough that they may want to do something else in the meantime.

## 2. Read the JSON and derive the metrics the report actually displays

Each output file has this shape:
```
{
  playerCount, difficulty, gameCount, seed,
  overall: { rows: CardStatsRow[], avgRoundLength, avgFlipRate },
  byLocation: { [CenterEffectId]: { games, rows: CardStatsRow[], avgRoundLength, avgFlipRate } }
}
```
`CardStatsRow` (see `lib/playtest/cardStats.ts`) already has `cardId, played,
copiesInDeck, playRate, avgOwnScore, avgFinalScore, avgPlacement, avgPlacementDelta,
avgRoundLength, avgDisruption, flipRate` — all `null` for a card never played in that
bucket (0 copies in the deck at that player count, or genuinely never drawn).

Three more metrics the report needs are **not** in the JSON — they're page-local
helpers in `app/playtest/page.tsx`, reproduce them exactly:
- **Own Δ** (`od`): `row.avgOwnScore - CARD_DEFS[cardId].base` (null if `avgOwnScore` is null).
- **Value** (`va`): for a `"Control"`-bucket card, `CARD_DEFS[cardId].base + row.avgDisruption`; every other bucket, just `row.avgOwnScore`.
- **Impact** (`im`): `-row.avgPlacementDelta * row.playRate` (null if either input is null). Positive = strong and common (worth a balance look); negative = actively bad and common (a trap card).

Build the report's data objects per player count:
- `CARD_STATS[name] = [bucket, { pd: avgPlacementDelta, im: impact, pl: round(playRate*100), va: value, od: ownDelta, fs: avgFinalScore, di: avgDisruption, fr: round(flipRate*100) }]`, keyed by the card's **display name** (`CARD_DEFS[id].name`, e.g. "Hoplite" not "Footman") — cross-reference `lib/content/cards.ts`.
- `PD[name] = LOCATIONS.map(loc => byLocation[loc.id]?.rows.find(r => r.cardId === id)?.avgPlacementDelta ?? null)` — one entry per location in the template's fixed `LOCATIONS` order, `null` where that card never appeared at that location.
- `NO_DATA_CARDS`: any card with `playRate === null` overall (0 copies in the deck at this player count, e.g. a card gated to a different player-count range) — state the real reason from `cards.ts`'s `count` array, not a guess.
- `OVERVIEW.rl` / `OVERVIEW.fr`: `avgRoundLength`/`avgFlipRate` (as %) per location, same order as `LOCATIONS`.
- `CARDS_META[name]`: play rate % for the heat-strip tooltips.

`classifyCard`'s balance score is already in the template's JS (score/tag/color from
Placement Δ magnitude + cross-location stdev) — don't recompute it by hand, just make
sure `PD` is populated correctly since the score reads directly from it.

## 3. Write real insights — this is the part that can't be mechanical

For every card with data, write 1-2 sentences (`INSIGHTS[name]`) explaining its
Placement Δ **in terms of its actual printed rule**, and its most notable
best/worst-location result if there's a clean mechanical reason for it. Read the
card's real `text`/`fullText` in `lib/content/cards.ts` before writing anything about
it. If a prior run's numbers are available for comparison (ask the user, or check for
an earlier report), say whether a number moved and by how much — don't just describe
the current number in isolation.

For every location (`ANALYSIS[i] = { best: {name, text}, worst: {name, text} }`), read
its real `description`/mechanic in `lib/content/centerEffects.ts` and explain *why*
the best/worst card's kit interacts with that specific rule the way the numbers show —
name the actual trigger condition, not just "this card does well here." If two cards
are close, say so and pick the more mechanically interesting one, or tie them (see the
template's `tie`/`v.name.split(" / ")` handling for how a tied verdict renders).

**Filter to a minimum sample size BEFORE picking best/worst, then match the pick
exactly.** `best`/`worst` in each location's `ANALYSIS` entry should be the most
negative/positive `PD` value among cards with **at least 8 games played at that
location** — not the literal argmin/argmax of every card regardless of sample size.
Thin-sample cards (a 1-2 game outlier at ±1.00) still show up in the heat-strip below
(don't remove them from `PD`), they're just excluded from the cited verdict; say so
once in the section's own `.section-note` rather than flagging it separately in each
card. Two failure modes to avoid, both hit by earlier drafts of this report:
1. *Citing the raw extreme regardless of sample size* — a 1-game "+1.00" outlier isn't
   a real finding, and flagging it `low-sample` doesn't make it a good headline; better
   to just filter it out of contention entirely and cite a real, reliable number.
2. *Silently substituting a "better" card without changing the selection rule* — the
   very next draft after fixing failure mode 1 handled this correctly by filtering
   first, then picking; don't regress back to eyeballing a "more mechanically
   interesting" card that isn't actually the extreme among reliable candidates, since
   that's exactly what breaks the verdict-vs-strip agreement again.
If literally no card reaches the sample threshold at some location, fall back to the
true extreme with an explicit `confidence: "low-sample"` flag and a one-line "only N
games here" text — don't force a manufactured insight out of noise.

Before publishing, mechanically verify every entry: filter each location's cards to
`played >= 8`, confirm `ANALYSIS[i].best.name` matches whichever of those has the
lowest `PD[name][i]` and `ANALYSIS[i].worst.name` the highest — don't eyeball this by
hand, actually check it with a script and diff against what's in `ANALYSIS`.

Never write a generic sentence that could apply to any card ("this card performs
well here") — every insight must name the specific mechanic.

## 4. Build and publish the report

Copy `lib/playtest/scripts/balanceReportTemplate.html` as your starting point — don't
rebuild its CSS/visual system from scratch, it's a proven design. Before writing/editing
it further, **load the `artifact-design` skill** (required before any artifact publish).

Replace the placeholder caveat box, KPI row, and the `OVERVIEW`/`CARDS_META`/`PD`/
`CARD_STATS`/`NO_DATA_CARDS`/`INSIGHTS`/`ANALYSIS` block with this run's real data and
insights (steps 2-3 above).

**If more than one player count was run** (the default is both 4 and 8), the single
report needs a way to switch between them — the template as saved is single-dataset
only. Add:
- A `DATASETS` object keyed by player count, each holding that count's own
  `OVERVIEW`/`CARDS_META`/`PD`/`CARD_STATS`/`NO_DATA_CARDS`/`INSIGHTS`/`ANALYSIS`
  (`LOCATIONS` stays shared — the location list doesn't change with player count).
- A `<select>` (or segmented control, matching the existing `.control-group`/
  `select` styling) in `.profile-controls` for "Player count", defaulting to whichever
  count has more total games played (or just the first one run).
  KPI row, `renderProfiles()`, and the location-grid render all need to read from
  `DATASETS[currentPlayerCount]` instead of the top-level consts directly, and both
  the profile grid and location grid need to re-render on a player-count change (same
  pattern as `profile-sort`'s existing change listener).
- The caveat box should say which player counts this report actually covers.

Publish via the Artifact tool. Title it something specific to what this run actually
covers (e.g. "4p/8p Expert Balance" or similar) — not a repeat of the generic
"Location Report" name unless the user wants that exact title kept.

## 5. Report back

Tell the user: how many games ran at each player count, how long it took, where the
report is, and call out the single most interesting or surprising finding from this
run's own numbers (a card whose balance score moved a lot, a location with an unusually
extreme best/worst gap, a low-sample caveat worth double-checking with a bigger run).
