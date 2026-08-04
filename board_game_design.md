
/
Board Game
Board Game







Recents
Game spec review
2 minutes ago
Design review
16 hours ago
Instructions
You're helping me build a turn-based multiplayer board game — a hidden-information grid card game with a shared-screen + phone-controllers (Jackbox-style) architecture. Stack: Next.js (App Router), TypeScript, Tailwind, Socket.IO for real-time sync. The full design is in the project knowledge doc. Prefer concise, concrete answers with real code over long explanations. Flag when a design choice touches something marked "locked" vs. a "parked" tuning knob.

Memory
Only you
Project memory will show here after a few chats.

Context
1% of project capacity used

game-spec-1.md
202 lines

md



game-spec-1.md
177 lines

md



board-game-design.md
137 lines

md


board-game-design.md


# Board Game — Design Doc
 
A turn-based, hidden-information grid card game. Digital-only, because the hidden values and chained neighbor effects are painful to track and calculate by hand — the computer doing that bookkeeping invisibly is the whole reason this is a video game.
 
---
 
## Core premise
 
- A **grid board** with a **special center tile** that applies a game-wide effect (a rule-changer drawn at game start — see below).
- Each player has a **fixed hand** of cards drawn at the start of the game.
- On a turn, a player **places one card face-down** onto the board.
- Cards have a **base value of 5** plus a printed **effect** that modifies scoring (their own or neighbors').
- At the start of their turn, before placing, a player may **flip one card face-up** (any card on the board; it stays up).
- After every player has acted in a round, all players **vote** whether to keep playing or end the game.
- When the game ends, the board is **revealed and scored**, and the highest total wins.
---
 
## Structural spine (LOCKED — these define the data model)
 
- **Board = coordinate map**, `{x, y}: card`, not a fixed 2D array. Easier to code and grows naturally from the center.
- **Bounded to a box** — placement must be within a max width × height envelope around the center. Store **width and height separately** (each a function of player count) so they can be tuned independently.
- **Placement rule: orthogonal only.** A card must be placed face-to-face adjacent (up/down/left/right) to an existing card. This guarantees every placement immediately interacts with something — no "safe drop" dodges, no thin-cross sprawl. Growth is organic but fills in solid because effects reward density and the armpit cells are always legal.
- **Effect adjacency: orthogonal only**, matching placement. Keeps the vocabulary clean ("the card to its left") and avoids the diagonal-placement-but-orthogonal-effect exploit.
- **Scoring: at the END, off BASE values, resolved simultaneously.** Every effect reads neighbors' base value + printed modifiers, NOT their fully-resolved score. This avoids circular/chained dependencies and infinite loops, and keeps scoring computable. Keep every effect readable off base values only.
- **Hands: fixed**, drawn at start. (Mulligans parked — see below.)
- **Card ownership**: every card carries an `ownerId`. Rendered identically face-down on the shared screen, but the server knows ownership for per-player scoring breakdowns and owner-dependent effects.
---
 
## Architecture (LOCKED)
 
- **Shared-screen + phone-controllers (Jackbox model).** Server holds authoritative game state and broadcasts it; different clients render different slices:
  - **Laptop** = the board client, shows public state big.
  - **Each phone** = a player client, shows only that player's private view (hand, options, turn prompt, vote).
- **Each connection declares a role** ("board" vs "player X"); server tags it and targets messages accordingly (keeps votes/hands hidden from the shared screen).
- **Socket.IO** for real-time sync; use its **rooms** feature for a game session.
- **Turn-based**, same-room for now (players hit the Mac's local IP). No cloud deploy needed yet; Railway/Render/Fly.io later if going remote.
- **State** in-memory to start (a JS object on the server is fine for one session); SQLite if games need to survive a restart.
- **Mobile-first UI** (touch targets, portrait, no hover-dependent interactions). Test on a real phone early.
- Stack: **Next.js (App Router), TypeScript, Tailwind**.
---
 
## The loop (mental model shift from the CRM)
 
`action → send to server → server validates & updates authoritative state → server broadcasts → all clients re-render their slice`
 
One extra hop vs. the CRM's `action → mutate DB → re-render`. Prove this pipe first (two devices passing one message), then everything else is the same pattern.
 
**Build order:** (1) two devices in a Socket.IO room passing a message; (2) game state on server + one action (advance turn) end-to-end; (3) real rules; (4) voting last (it's just a specialized commit-and-broadcast).
 
---
 
## Voting
 
- **Simultaneous commit, then tally.** Each player commits privately; when commit count == player count, reveal and resolve. Simplest sync shape there is — a checklist filling up, no race resolution.
- **Tie → continue.** Ending is the disruptive, irreversible action, so it requires a real majority. (Alternative: tie → end, for shorter/higher-stakes games. Default-continue is safer.)
- **Minimum-round floor** before voting is allowed (start at 3, tunable constant).
---
 
## Endgame — triggered by whichever comes FIRST
 
1. The vote passes.
2. The **turn/hand limit** hits (hands are finite, so there's a natural ceiling; optionally cap lower to leave cards unplayed for tension). **Decide:** does an empty hand end a player's participation, or the whole game?
3. The **board fills** (no legal placements left — possible now that the board is bounded). **Decide:** a player with cards but no legal spot passes, or the game ends.
Because game length is bounded almost entirely by these, the min-round floor and vote-tie rule carry weight — playtest them specifically.
 
---
 
## Board sizing (scales with player count)
 
- Board capacity should be **somewhat LESS than total cards in play** (`players × hand size`), so space runs out and placement is contested. If the board is bigger than the card total, it never fills, row/adjacency ceilings never bite, and spatial tension evaporates.
- Rough heuristic: `board cells ≈ total cards × factor < 1`. E.g. 3 players × 5 cards = 15 cards; a tight ~3×4 or 4×4-with-center board forces competition. Add a row/column per extra player. Tune the factor by playing.
- **Width vs. height is a balance lever:** scaling by *longer rows* strengthens row-referencing cards at high player counts; scaling by *more rows* (each a stable length) keeps directional-card values consistent across counts. This is why width and height are stored separately.
---
 
## The center tile
 
Use it as a **rule-changer drawn at game start** rather than one fixed effect — near-zero extra code (a modifier applied at scoring), big replayability. Examples: "center doubles adjacent cards," "center column scores negative," "every card's left-effect also applies upward."
 
---
 
## Effect design philosophy
 
The physical game's row/column effects felt lame because they rewarded **quantity in a line** (stack the fat row) rather than thoughtful placement — a stacking optimization, not a spatial puzzle. Fix: favor **directly-adjacent and relational effects**, and — crucially — **effects that pull in OPPOSING directions** so no single strategy dominates. When some cards want density, some want isolation, some want to be near opponents, some near the center, every placement becomes a real decision.
 
Categories to draw from:
 
**Adjacency-count (the good version of row cards)**
- +2 per orthogonally adjacent card (capped at 4 — about timing, not stacking).
- −1 per adjacent card (rewards open space / corners — gives empty cells value).
**Conditional / relational (create "good next to X, bad next to Y" tension)**
- +4 if adjacent to the center tile, else 0 (makes center contested).
- +3 if adjacent to an opponent's card, −3 if adjacent only to your own (rewards playing into the fray).
- Copies the base value of the card above it.
**Act-on-neighbors (most interactive — attacks & protection)**
- Adjacent cards score 0 (a bomb — place next to an opponent's big card).
- Adjacent cards can't be flipped face-up (a protector; interacts with the reveal mechanic).
- Swap values with the card to your right at scoring (bluffs & reversals).
**Reward spread, not stacking (direct antidote)**
- +5 if the only card in its row AND column (rewards isolation).
- Value ×2 if not adjacent to any card of the same owner (punishes self-clumping).
**Feed the flip mechanic (currently underused by effects)**
- +3 while face-down at scoring (makes opponents' flip choices meaningful).
- +2 per face-up card adjacent to it (makes revealing feed into scoring).
**Balance caution:** effects referencing other cards' *values* (copy/swap/double) must read **base** values only, per the locked scoring rule — keeps them loop-free.
 
---
 
## Open tuning knobs (PARKED — decide by playtesting, keep configurable)
 
- **Mulligans.** Three variants, meaningfully different games. **Build pure fixed-hand FIRST** (simplest to implement and balance; can't judge if mulligans are needed until played). Add later on top — they're just hand-manipulation actions:
  - Draw one / discard one each turn (safe, freshens hands).
  - Pass a card to another player (spicy, social/negotiation layer, bigger balance question).
  - Pure fixed hand (most strategic, cleanest to balance, least forgiving).
- **Owner-dependent effects** ("+2 if the card to your right is an opponent's"). Rich space, free to compute digitally. **Thread `ownerId` through the scoring function from day one** even if not used yet — trivial now, annoying to retrofit.
- **Player-count-gated cards** (7 Wonders style). Skip the logic for now, but include a `minPlayers`/`maxPlayers` field on the card model so it's ready.
- **Exact numbers:** min-round floor, turn cap, board width/height, hand size — all constants/config, tuned by playing.
- **Diagonal-referencing cards** — could add later as a special category, but base game is orthogonal.
---
 
## Why digital (the project's justification)
 
- **Ownership tracking** is free (`ownerId`) — the painful physical problem becomes a feature (color-coded per-player scoring breakdowns, animated reveals).
- **Calculation** is instant and can be shown step-by-step as a reveal animation.
- **Hidden values + chained effects** — the exact bookkeeping humans hate — is what the computer does invisibly.
 
