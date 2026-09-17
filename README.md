# Betrayer's Ball

A turn-based, hidden-information grid card game. Place cards face-down, flip them at the right moment, and score off their printed values once the game ends — support cards buff/debuff their neighbors, so *when* you reveal a card matters as much as what it is.

Play solo against AI, or host a real multiplayer game — either everyone joins from their own phone (Jackbox-style), or one device acts as a shared screencast display while players use their phones as controllers.

## Play now

- **[betrayers-ball.onrender.com](https://betrayers-ball.onrender.com/)** — the real deployment, with full multiplayer support.
- **[board-game-bice.vercel.app](https://board-game-bice.vercel.app)** — backup mirror. Single-player only: Vercel's serverless hosting can't run the persistent Socket.IO server multiplayer needs, so hosting/joining a room isn't available there (the app will tell you if you try).

## Features

- Single-player vs. AI, with three difficulty levels
- LAN multiplayer — host a room, everyone else joins from their own browser
- Screencast mode — one device shows the board, everyone else plays from their phone
- A dozen+ locations (center-tile effects) that bend the normal rules for the whole game
- In-app card/location catalogs, per-game and lifetime stats, and a card-balance simulator for playtesting

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
