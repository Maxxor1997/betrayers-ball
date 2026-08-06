@AGENTS.md

# Board Game — Agent Context

Turn-based hidden-info grid card game. Shared-screen + phone-controllers (Jackbox model).
Stack: Next.js (App Router), TypeScript, Tailwind, Socket.IO.

## Design docs (read these)
- game_spec.md — card set, deck counts, board sizing, scoring model, endgame
- board_game_design.md — structural/architecture rationale

## Core rules that shouldn't drift
- Board = coordinate map {x,y}: card, not a 2D array
- Placement & effect adjacency: orthogonal only
- Scoring: end-only, simultaneous, off BASE values (never resolved values) — loop-free
- Two-phase: resolve → freeze → post-resolution layer
- Every card carries ownerId; center = ownerless neighbor (base 0)
- Ownerless tiles (center, and any extra tiles a location adds, e.g. Three Headed
  Dragon's heads) count as permanently face-up for any effect that keys off a
  neighbor's face state — they hold no hidden info, so there's nothing to be face-down
  about
- Server holds authoritative state; clients render slices by role

Numbers (bases, counts, board size) are tuning knobs, not fixed. When something
here conflicts with a more recent decision, the newer decision wins.

## Testing changes
Never start the dev server or test in a browser yourself (no `npm run dev`, no
launching/driving the app) — the user runs and checks it themselves. Verify changes
with typecheck (`npx tsc --noEmit`) and the test suite (`npx vitest run`) instead.