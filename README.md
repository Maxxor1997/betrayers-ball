# Betrayer's Ball

A multiplayer, turn-based, hidden-information grid card game with a social deduction element.

Place cards on the board to build the highest total score. Cards start face-down and are worth their base value plus effects from themselves or other cards — position, ownership, face-up status can all matter.

Play solo against AI, or host a real multiplayer game (2-8p) — all players join from their own phone (Jackbox-style).

<img width="557" height="546" alt="Screen Shot 2026-09-17 at 3 55 50 PM" src="https://github.com/user-attachments/assets/0e9f0de2-1e55-4052-940e-4470f39e369e" />


## Play now

- **[betrayers-ball.onrender.com](https://betrayers-ball.onrender.com/)** — main deployment with multi-player support.
- **[board-game-bice.vercel.app](https://board-game-bice.vercel.app)** — backup mirror, single-player only.
  
## Features

- Single-player vs. AI, with four difficulty levels
- LAN multiplayer(2-8p) — host a room, everyone else joins from their own browser
- Screencast mode(2-8p) — one device shows the board, everyone else plays from their phone
- A dozen+ locations (center-tile effects) that bend the normal rules for the whole game
- In-app card/location catalogs, per-game and lifetime stats
- Card Balance, AI Arena, and Sandbox modes for experimentation

## Development

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000). `npm run dev` runs the real custom server (`server.ts`) with Socket.IO attached, so multiplayer works locally too — other devices on your network can join at the LAN address printed in the terminal.

Other scripts:

```bash
npm test         # run the test suite once
npm run test:watch
npm run build && npm start   # production build + the real server
npm run lint
```

## Tech stack

Next.js (App Router) + TypeScript + Tailwind, with a custom server (`server.ts`) attaching Socket.IO for real-time multiplayer. See `CLAUDE.md`/`AGENTS.md` for the fuller architecture rundown, and `game_spec.md`/`board_game_design.md` for the game's own rules and design rationale.
