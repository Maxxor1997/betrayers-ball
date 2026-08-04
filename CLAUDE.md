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
- Server holds authoritative state; clients render slices by role

Numbers (bases, counts, board size) are tuning knobs, not fixed. When something
here conflicts with a more recent decision, the newer decision wins.