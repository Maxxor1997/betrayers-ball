# Game Spec — Working Baseline v2 (4-player target)

> **⚠️ SNAPSHOT — not set in stone.** Point-in-time capture of an in-progress design conversation. Originally generated **2026-08-03**, card-set overhaul **2026-08-04**, and this **v2 revision 2026-08-04** (session that grew the set from 12 → 16 cards, added the Footman line bonus, Chronicler, Suppressor, Headsman, re-added Pretender, and introduced effect-resolution ordering). It is a *working baseline*, not a final spec. Every number is a playtest starting point; even LOCKED items are "locked for now." Later conversations, playtests, or agents may supersede any of this — when it conflicts with a more recent decision, the more recent decision wins. Companion `board-game-design.md` holds the deeper structural/architecture rationale.

Everything here is a **config constant / parked tuning knob** unless flagged **LOCKED**.

---

## Core invariants (LOCKED)

- **Points live on cards only.** A player's score is the sum of the cards they own (`ownerId`). No effect awards points to a player directly — effects modify *cards*. (Champion of the Weak transfers a *card*, not points.)
- **Base value benchmark = Footman 5.** Any card better than a Footman pays for it with a sub-5 base or a real downside. (Chronicler is base 2 but its *effective* value scales past 5 with game length — a conditional payment rather than a flat stat penalty; see flag.)
- **Scoring is end-only, simultaneous, off base values.** Scoring-time effects read neighbors' base value + the card's own printed modifiers, positions, identities, ownership, or flip-state — **never** other cards' fully-resolved values. Keeps scoring loop-free.
- **Anything reading a *resolved* value runs as a post-resolution layer** (see two-phase scoring), never during the simultaneous pass.
- **Center = ownerless neighbor.** Counts as a real orthogonal neighbor for adjacency/trigger/penalty effects, belongs to no one, base 0 / not counted normally, not placeable-on. Owner checks skip it.
- **Placement & effect adjacency: orthogonal only.** Every card placed face-to-face adjacent to an existing card, within the bounded box.

---

## The 17-card set

All numbers parked. **(v2 — grew from 12 to 16 this session; Truthseeker added afterward. See "What changed in v2" below.)**

| Card | Base | Effect | Bucket |
|---|---|---|---|
| Footman | 5 | +1 to itself if part of a line of 3+ consecutive same-owner Footmen (orthogonal, same row or column) | Slam |
| Giant | 6 | Always face-up (can't be played face-down) | Slam |
| Warlord | 8 | −3 per other Warlord on the board (any owner), floored 0 | Slam |
| Exile | 9 | −2 per neighbor (any owner), floored 0 | Slam |
| Pretender | 7 | −5 to self if any adjacent **face-up** card has base ≥ 7 (any owner) | Slam |
| Berserker | 3 | +2 per other Berserker owned by a *different* player | Engine |
| Commander | 2 | +2 per adjacent Footman (any owner) | Engine |
| Champion | 4 | +3 if face-up at scoring | Engine |
| Darkspawn | 2 | +5 if 2+ adjacent face-down cards (any owner) | Engine |
| Chronicler | 2 | +1 per round elapsed at game end (global final-round number) | Engine |
| Earthshaker | 3 | −1 to every other card in its row (any owner, not itself) | Control |
| Skysplitter | 3 | −3 to the card above and the card below (any owner) | Control |
| Bannerman | 4 | +2 to each adjacent Footman, +1 to each other adjacent card (any owner, not itself) | Control |
| Plague Bearer | 3 | If 2+ adjacent Footmen (any owner), those Footmen score 0; keeps own base | Control |
| Suppressor | 3 | If 3+ adjacent cards (center counts): each adjacent non-Suppressor card is treated as vanilla — base value only, printed text negated (any owner). Suppressors immune to negation. | Control |
| Headsman | 3 | Each adjacent **face-up** card with base ≥ 6 scores −4 (any owner) | Control |
| Truthseeker | 4 | **Placement-time trigger** (not a scoring effect): immediately flips every adjacent card face-up (any owner, including your own). Bypasses flip-lock rules (Shadowlands/Prying Eyes/round gate) and Suppressor negation, and doesn't consume the turn's normal flip. | Control |

Balance: **5 slam / 5 engine / 7 control** (card count). Copy-count buckets are more even — see deck.

### Chronicler value curve (base 2, +1/round)

| Game ends round | 3 | 4 | 5 | 6 (cap) |
|---|---|---|---|---|
| Chronicler value | 5 | 6 | 7 | 8 |

Near-dead in a short game, Warlord-ish at full length. Rewards trailing players for voting to continue → catch-up tied to the endgame vote.

### What changed in v2 (this session)

- **Footman** — no longer vanilla. Added a **line bonus**: +1 to each Footman in a line of **3+ consecutive same-owner** Footmen (row or column). Flat +1, max once per Footman regardless of how many lines it's in. Adds blockable positioning (one enemy card in the line kills it). Loop-safe (reads positions + ownership).
- **Chronicler — NEW** (engine, base 2). +1 per round elapsed at game end; reads the *global final-round number* (not a per-card placement stamp), so no new per-card state and loop-safe. Catch-up engine tied to the vote.
- **Suppressor — NEW** (control, base 3). Negates adjacent non-Suppressor cards' text (both self-mods and outgoing effects) → they score base only. Requires **3+ adjacent cards** to activate (center counts), so it can't be cheaply dropped on one target and must be built into / played into density. Dual-use: suppress an opponent's engine OR make your own downside slams (Exile, Warlord) score full base. Suppressors immune to each other.
- **Headsman — NEW** (control, base 3). Each adjacent **face-up** card with base ≥ 6 scores −4. Anti-fat-slam counter (Giant/Warlord/Exile), keyed to face-up so it feeds the flip layer. Giant is forced face-up → permanent Headsman target.
- **Pretender — RE-ADDED** (slam, base 7). Was cut in v1 for too-narrow trigger; re-added and **improved to face-up-only**: −5 only if an adjacent **face-up** card has base ≥ 7. Face-down big neighbors are harmless until revealed → flipping becomes a weapon against Pretender specifically.
- **Cleaver → Earthshaker, Hammer → Skysplitter** (renamed in v1; note the horizontal/vertical mapping): **Earthshaker = row** (−1 whole row), **Skysplitter = vertical** (−3 up/down). Confirmed in v2.
- **Assassin — remains CUT** (cut in v1; Darkspawn holds the engine slot). Flip pair deliberately broken; asymmetry intended.

---

## Effect resolution order (LOCKED structure — NEW in v2, constants tunable)

The growing set of meta/conditional effects needs a defined order. Two-phase model still holds; within Phase 1 (Resolve), apply in this order:

1. **Suppression pass (first).** For each active Suppressor (3+ adjacent cards, center counts), mark each adjacent non-Suppressor cell as *negated*. A negated card contributes **base value only** — its own modifiers AND its outgoing effects are cancelled. Suppressors are never negated.
   - **Footman-line edge case:** a negated Footman still occupies its cell and still counts as a same-owner Footman *link* for its neighbors' line, but does **not** receive its own +1 (its text is off). ("Still a link, gets no bonus.")
   - **Two adjacent Suppressors:** both remain active; neither negates the other; each negates its own non-Suppressor neighbors.
2. **Value-modifying pass (simultaneous, base-value reads only).** All non-negated effects compute at once off base values / positions / identities / ownership / flip-state: Footman line bonus, Bannerman, Commander, Berserker, Champion, Darkspawn, Chronicler, Exile, Warlord, Earthshaker, Skysplitter, Pretender, Headsman.
3. **Zeroing pass.** Plague Bearer sets qualifying Footmen to 0 (a negated Plague Bearer does nothing).
4. **Floors.** Warlord / Exile floored at 0.
5. **Freeze.** All card values final and immutable.
6. **Post-resolution layer.** Center effects that read *resolved* values or *final standings* (Champion of the Weak, Kingslayer) apply here on the frozen snapshot, single pass, never feeding back.

**Open ruling:** whether Suppressor negates Giant's "always face-up" (a placement/state rule, not a scoring effect). Current lean: **no** — out of scope, face-up is a state property, not suppressible text.

---

## Deck (72 cards, tune for variety)

Deliberately much bigger than any single deal so hands vary game to game. At 4p × 7-card hands you deal 28; 72 leaves **~61% unseen** per game.

| Card | Copies | Bucket |
|---|---|---|
| Footman | 12 | Slam |
| Warlord | 5 | Slam |
| Giant | 3 | Slam |
| Exile | 3 | Slam |
| Pretender | 3 | Slam |
| Berserker | 8 | Engine |
| Commander | 5 | Engine |
| Champion | 5 | Engine |
| Darkspawn | 4 | Engine |
| Chronicler | 3 | Engine |
| Bannerman | 4 | Control |
| Skysplitter | 3 | Control |
| Earthshaker | 3 | Control |
| Plague Bearer | 3 | Control |
| Suppressor | 2 | Control |
| Headsman | 2 | Control |
| Truthseeker | 4 | Control |

**Total: 72.** Copy buckets: **Slam 26 / Engine 25 / Control 21.**

Weighting logic: Footman is the backbone (bluff layer + Commander/Bannerman fuel + Plague Bearer target + line-bonus payoff) — 12. Berserker held at 8 (second pillar; cross-owner bet must stay reliably live — *usually* live, occasionally not). Commander/Champion at 5 (present at the larger deal; Champion is the main flip payoff). Darkspawn 4 (swingy, don't flood). **Control kept scarce by copies despite being the biggest bucket** — the doc's "don't make the board a demolition derby" rule; lots of *kinds* of control, few copies each. **Suppressor & Headsman rarest at 2** — high-impact "your card did nothing" swings, so lurking threats not staples (each appears in ~half of 4p deals). Chronicler 3 — scarce so catch-up swings games rather than becoming uniform inflation. Truthseeker at 4 — a placement-time information swing (see the 17-card table), kept modest since it bypasses flip-lock rules entirely. Deck size is the variety dial; scale toward ~60 for tighter balance-testing.

---

## Hand size & board sizing

- **Draw 7, place ~6.** Dealt 7, max rounds capped at ~6, so every player always strands ≥1 card. Flat across player counts. Both tunable.
- **Why draw-7/cap-6:** guaranteed leftover makes stranding a *choice* ("which card do I hold back?"), richer hidden info (no one empties their hand), and the cap reliably fires as a round-boundary endgame trigger with equal turns for all.
- **Board sized to cards placed, not dealt.** ~6 placed per player.
- **Board scales with player count** (width & height stored separately, LOCKED). Height held at 5 for Skysplitter/Earthshaker balance and a true center; width grows with players.
- **True center → odd × odd**, center pinned at exact middle, hard-bounded envelope. Landscape preferred (width ≥ height).
- **Capacity target ~70–80%** of cards placed (LOCKED heuristic: board < cards so space runs out).
- **Free balance diagnostic:** if players consistently strand the *same* card type, it's probably underpowered.

| Players | Cards placed (~6) | Board (W×H) | Usable (−center) | Capacity | Notes |
|---|---|---|---|---|---|
| 2 | 12 | 5×3 | 14 | 86% | Landscape; flat board = mild Skysplitter weakness |
| 3 | 18 | 5×5 | 24 | 75% | Square |
| 4 | 24 | 7×5 | 34 | 71% | **Target config**; landscape |
| 5 | 30 | 9×5 | 44 | 68% | Landscape |

**4-player target: 7×5 board, center pinned true-middle, 34 usable cells, ~24 placed, ~71% capacity.**

---

## Two-phase scoring model (LOCKED)

1. **Resolve** — every card computes simultaneously off base values + printed modifiers (per the resolution-order section above). No effect reads another card's resolved value.
2. **Freeze** — all card values final and immutable.
3. **Post-resolution layer** — center effects reading *resolved* values / *final standings* apply on the frozen snapshot, single pass, never feeding back.

---

## Center pool (one drawn at game start)

- **No Man's Land** *(scoring-time)* — every placed card on the center's row or column scores −2. Plus-sign; center exempt. Taxes only the opening card per cluster (others can step off the cross).
- **Mirror Pool** *(scoring-time)* — each card has one mirror position (same column, opposite side of center row). If occupied, both cards +1; +2 each if same card type. Any owner.
- **Champion of the Weak** *(post-resolution)* — center is a scorable card worth 5 (modifiable by adjacent buffs/dents at resolution). After freeze, transfers to the *unique* last-place player (its value then counts for them). Tie for last → goes to no one. Strong catch-up.
- **Kingslayer** *(post-resolution)* — highest frozen card(s) on the board set to 0. Ties → all zeroed. Anti-value-concentration.
- **Shadowlands** *(rule-toggle)* — flipping allowed only on rounds 2, 4, 6. Throttles info; hidden info stays sticky. Nerfs Champion, shrinks Darkspawn's late face-down pool. Rule-toggle only — no direct score effect / no center card transfer. **At 2p, disables flipping for the entire game instead** (see Flipping below).
- **The Reckoning** *(rule-toggle)* — at the start of round 4, every player discards their hand and draws the same number of fresh cards from a shared reshuffled pool (their own discards included, so there's always enough regardless of player count). Resets any built-up hand read; punishes over-committing to a hand plan early.
- **Prying Eyes** *(rule-toggle)* — flipping unlocked from round 1 (skips the normal round-2/round-3 gate entirely), but you can never flip your own cards — only opponents'. Pure information-race effect: everyone's hidden cards are only ever revealed by someone *else*.

---

## Flipping (LOCKED structure, constants tunable)

- **Turn order:** (1) optionally flip one card face-up, then (2) place one card. Flip-before-place so the reveal can inform placement.
- **Placement mandatory** (unless no legal orthogonal spot → pass).
- **Flipping optional** — flip one card, or none. Never forced.
- **Flip unlocks at round 2** (round 1 placement-only). **At 2p, delayed to round 3** — with only one opponent, a single flip removes all "unknown" for that card faster than in larger games, so 2p games get one extra round of pure placement first.
- **What you can flip:** any face-down card, any owner (Prying Eyes narrows this to opponents' cards only).
- **Permanent** — once face-up, stays up.
- **One flip per turn** max.
- **Under Shadowlands:** further restricted to rounds 2, 4, 6 (or the 2p-delayed equivalent) — **except at 2p, where Shadowlands disables flipping for the whole game** rather than shifting the schedule.
- **Truthseeker is not the flip action** — its placement-time reveal ignores all of the above (round gate, Shadowlands, Prying Eyes) and doesn't consume the turn's one-flip allowance. It's the card's own printed effect, not the player's optional flip.

---

## Endgame & fairness (LOCKED)

- **Triggers (whichever first):** (1) vote passes, (2) turn/hand cap hits, (3) board fills (no legal placements).
- **Game only ends at a round boundary** — all triggers checked after every player has taken their turn in a round (equal turns → fairness).
- **No-legal-move players pass** for the rest of the game (they don't end it). Cards may strand — intended tension.
- **Voting:** simultaneous private commit, tally when commit count == player count. **Tie → continue** (ending is the disruptive action; needs a real majority). At 2p, ending is by consensus.
- **Turn/round cap ~6** (draw 7, cap 6 → every player strands ≥1).
- **Min-round floor** before voting allowed — start at 3 (tunable).
- **⚠️ MISSING RULE (flagged in v2 sim):** no final-tie-break defined. A 3p game ended 27/27/24. Decide: most cards owned / shared win / tiebreak by highest single card. Currently undefined.

---

## Shakiest numbers / things to playtest first

1. **The Footman core (now with line bonus).** Footman(5, +1 in a line) + Commander(+2/Footman) + Bannerman(+2/Footman) compound in a dense corner, and the line bonus rewards the same shape. Highest ceiling in the set. Counters: Plague Bearer (targeted), Exile (general), Earthshaker/Skysplitter (shave), Suppressor (negate). Confirm they're enough, and that a 3-in-a-row isn't *too* easy on a 5-wide board (test 3+ vs 4+).
2. **Chronicler** (base 2, +1/round). Confirm the 5→8 curve is real catch-up without dragging every game to the R6 cap. Keep scarce (3 copies).
3. **Suppressor** (base 3, 3+ adjacency trigger). The multi-card negate is a big swing; test the feel-bad ceiling and the self-activation tension (building the cluster negates your own cards too). Verify the resolution-order rulings (esp. Footman-line linking).
4. **Headsman** (base 3, −4 to adjacent face-up base ≥6). Test it doesn't make Giant unplayable (Giant is forced face-up → always vulnerable). Feeds flip layer.
5. **Pretender** (base 7, face-up-only −5). Confirm the face-up rework makes it an interesting flip-target rather than a passive 7. Watch the Pretender+Headsman overlap (both punish revealed big cards).
6. **Plague Bearer** (Footman-specific, 2+ adjacent → those Footmen 0). Two risks: too swingy (test 2+ vs 3+); dead card if Footman-stacking doesn't materialize. **v2 sim note:** under Shadowlands it stayed hidden all game and silently zeroed a player's whole Footman line — watch whether "countered by an unseen card" is tense-good or feel-bad.
7. **Commander ceiling** — base 2; 10 at four Footmen; may cap at 3 adjacent.
8. **Bannerman** — base 4, +2 Footmen / +1 else. Check the Footman spike and whether it's worth playing given the any-owner leak.
9. **Darkspawn** — base 2, +5 at 2+ adjacent face-down. Binary/swingy; you control the trigger. Threshold (2+) is the knob.
10. **Exile** — most board-size-sensitive; general anti-cluster valve. May be uncashable on tight high-player boards.
11. **Earthshaker** — row-wide −1 scales with width (−6 on a 7-wide row, more at 5p). Watch it's not oppressive; base 3 may want to drop to 2 at wide boards.
12. **Berserker** — +2/opposing copy; 8 copies so usually live. **v2 sim note:** at 3p the cross-owner bet is thinner; watch it bricking at low player counts.
13. **Hand size (draw 7 / cap 6)** — master dial for length & capacity.
14. **Shadowlands** — confirm 3 flip windows isn't too throttling; it meaningfully warped the v2 3p game (kept a Plague Bearer hidden all game).
15. **Endgame floor / vote-tie / MISSING final-tie-break** — carry weight; playtest specifically.
16. **Blowout / catch-up balance.** Champion of the Weak + Chronicler are both catch-up levers now — watch they don't over-erase skill (v2 3p sim: a weaker-playing opponent tied for first via Champion of the Weak).

---

## Deliberate omissions (carried + updated)

- **Copy/swap (value) cards** — cut. Value-copy fights the loop-free rule. (*Position*-swapping/movement as an action is parked as a possible later layer tied to the flip mechanic — loop-safe but touches locked "placement is permanent"; build fixed-placement first.)
- **Big Game Hunter as a card** — cut (reads resolved values). Reborn as the Kingslayer center effect.
- **Lightseeker** — prototyped (+2/adjacent face-up), cut as too passive before Darkspawn's face-down version landed.
- **Assassin** — cut; Darkspawn holds the slot. Flip pair deliberately broken.

---

## Parked tuning knobs (decide by playtest)

- **Mulligans** — build pure fixed-hand FIRST; add later (draw/discard, pass-a-card, or none).
- **Owner-dependent effects** — thread `ownerId` through scoring from day one even if unused.
- **Player-count-gated cards** — include `minPlayers`/`maxPlayers` on the card model, skip the logic for now.
- **Formation/set bonuses** — the Footman line is the first. If it plays well, opens a category (lines, blocks, patterns). Kept minimal (one card) for now.
- **Exact numbers** — min-round floor, turn cap, board W/H, hand size, all thresholds — constants, tuned by playing.
- **Final-tie-break rule** — NEEDS DECIDING (see endgame).
