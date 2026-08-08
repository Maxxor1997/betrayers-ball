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
- Every card's resolved value floors at 0, universally (see applyFloors in
  resolution.ts) — no per-card opt-in, no card can ever score negative no matter how
  many negative effects stack onto it
- Server holds authoritative state; clients render slices by role

Numbers (bases, counts, board size) are tuning knobs, not fixed. When something
here conflicts with a more recent decision, the newer decision wins.

## Testing changes
Never start the dev server or test in a browser yourself (no `npm run dev`, no
launching/driving the app) — the user runs and checks it themselves. Verify changes
with typecheck (`npx tsc --noEmit`) and the test suite (`npx vitest run`) instead.
`lib/server/wireSocketServer.ts` is the one exception worth knowing about: it's real
networking code (Socket.IO wiring), so `lib/server/__tests__/*.test.ts` spin up an
actual HTTP+Socket.IO server + real socket.io-client connections on an ephemeral port
inside the test process -- exercising it for real without needing the dev server or a
browser. Extend those tests, don't skip verifying this layer just because it's
network code.

## Multiplayer desktop architecture
`server.ts` (repo root) is now the real entrypoint (`npm run dev`/`start` run it via
`tsx`, not `next dev`/`next start` directly -- `dev:next-only` is the old plain-Next
escape hatch, single-player-only, no Socket.IO). It's a custom Next.js server (see
node_modules/next/dist/docs/.../custom-server.md) with a Socket.IO server attached to
the same HTTP server/port, binding 0.0.0.0 for LAN play. All actual game-hosting logic
lives in `lib/server/`:
- `session.ts` — `GameSession`, one per hosted room. Holds the true, unredacted
  GameState; runs the existing `applyAction` reducer unchanged; drives AI turns
  server-side the same way the single-player client's effect used to (delay, compute,
  apply, repeat).
- `protocol.ts` — the shared client↔server event/payload contract, plus
  `toWireState`/`fromWireState` (GameState's `Map`/`Set` fields don't survive a JSON
  round-trip, so they're flattened for the wire and rebuilt on receipt).
- `rooms.ts` — in-memory room-code registry (one process, no persistence -- rooms
  don't survive a server restart, matching board_game_design.md's original
  in-memory-to-start call).
- `wireSocketServer.ts` — the actual `io.on("connection", ...)` event wiring,
  deliberately decoupled from server.ts/Next so it's testable against a bare
  http+socket.io server.

Redaction (what a real opponent's client is allowed to receive) lives in
`lib/engine/playerView.ts`'s `redactedStateFor`/`redactedBoardFor` -- the same
"Unknown" pseudo-card substitution originally built for the AI's fair evaluation
(`estimateMargin`) turned out to be exactly what a real hidden-info multiplayer client
needs too, so `endgame.ts` and the server both call the same function now.

`app/components/Board.tsx` (`BoardGrid`) and `app/components/Hand.tsx` (`Hand`) are
shared between single-player (`app/play/page.tsx`) and multiplayer
(`app/join/[code]/page.tsx`) -- `BoardGrid` takes a `viewerId` + `nameFor` prop instead
of hardcoding single-player's `HUMAN` constant, specifically so it doesn't need to know
which mode it's rendering for.