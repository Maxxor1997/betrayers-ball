# Changelog

Append-only log of what changed, for manual testing — newest entry on top. Never edit
or delete an old entry; add a new one above it instead, even to correct something (add
a follow-up entry that says what was wrong).

## 2026-08-30 — Hall of Fortunes: fixed hand leaking between your own turns

- **Fix**: at Hall of Fortunes, your hand display was showing your *entire* remaining
  hand in between your own turns (from the moment your offered card was placed until
  your next turn started), instead of showing nothing until a new offer was drawn.
  **Test**: play a game at Hall of Fortunes, place your offered card, then watch your
  own hand area during the opponents' turns — it should show no cards (not your full
  hand) until your turn comes back around.

## 2026-08-30 — Kingslayer: real adjacency effects, negation, Plague Rat, Facestealer swap

- Kingslayer's center is now scored like a genuine card (internally, not a real extra
  player) instead of a hardcoded list of a few cards — so *every* adjacency effect
  applies to it automatically. Concretely this fixed: Chronicler never debuffing it,
  and Earthshaker debuffing it by the wrong amount (-1 instead of -2) — and newly
  wires up Plague Rat.
  **Test**: place Chronicler, Earthshaker, or Plague Rat face-up adjacent to the
  center at Kingslayer's Court and confirm the center's tracked value (hover it after
  the game ends) reflects the debuff.
- Suppressor/Lictor can now negate Kingslayer's steal ability entirely if it has 3+
  neighbors (same as it negates any other card's printed rule).
  **Test**: surround a Suppressor next to the center with 2 more filler cards (3+
  neighbors total) and confirm nobody gets hit by the steal at game end.
- Facestealer/Infiltrator (face-down) can now swap with the center if it's the
  highest-base adjacent candidate — the thief scores as Kingslayer from its own
  position, the true center scores as a plain Infiltrator instead, and the steal
  ability keeps firing from the center regardless (using its now-usually-lower
  value).
  **Test**: place a face-down Infiltrator next to the center with no other
  higher-base face-up neighbor, then check the end-of-game breakdown for both the
  Infiltrator and the center tile.
- Hovering the center tile after the game ends now shows a real point breakdown
  (base + every contribution), same as any other card.
  **Test**: hover/tap the center tile on the end screen at Kingslayer's Court.
- The center tile's displayed value no longer changes live during play (it used to
  tick up the moment a face-down Bannerman was placed nearby, leaking its presence
  before anyone flipped it) — it always shows the flat base value until the game ends.
- Catalog description trimmed back down to the basics.

## 2026-08-30 — Location rebalance + bug/UI batch

- **Dragon Gate**: ownerless tiles moved to immediately left/right of center; the true
  center tile is now free to play on.
- **Mirror Pool**: added two ownerless tiles at the top/bottom of the center column.
- **Twin Isles**: disabled (kept in code, no longer selectable/random-drawable).
- **The Borderlands** (new, placeholder name): edge cards +1, corner cards +2 (flat,
  not stacked).
- **No Man's Land** (new): ownerless corners instead of center; any card on the
  center's row or column takes -2.
- **Free Cities**: ownerless tiles are now genuinely random each game (seeded),
  scaling with board size — was a fixed spot before.
  **Test**: start a few Free Cities games at different player counts and confirm the
  ownerless tile(s) move around and scale up with board size.
- **Hall of Fortunes**: fully reworked. Instead of a round-4 hand redraw, every turn
  you're offered 3 random unique cards from your hand and can only place one of them;
  a fresh offer is drawn once the previous one is used.
  **Test**: play a full game at this location as human and as AI opponents; confirm
  only 3 cards are ever selectable at a time and they change turn to turn.
- **Lazaret**: now doubles your single lowest-value card regardless of face-up/
  face-down (previously required face-down).
- Sandbox mode's controls now stack cleanly on mobile instead of wrapping raggedly.
  **Test**: open Sandbox on a narrow/phone-width screen.
- AI-speed-in-ms number inputs (playtest arena) no longer show a leading `0` glitch
  when clearing and retyping a value.
  **Test**: on the playtest arena page, clear a Hard-difficulty ms field and type a
  fresh number (e.g. "250").
- Turn-order hover now shows only the most recent flip (not the full history) plus a
  "Last played" card, respecting hidden-info rules for opponents.
  **Test**: hover a player's row in the turn-order tracker mid-game.
