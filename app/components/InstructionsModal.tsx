"use client";

import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { PLAYER_DOT_COLOR_CLASSES, PLAYER_TEXT_COLOR_CLASSES } from "@/lib/config/players";

function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-semibold text-white dark:bg-zinc-100 dark:text-black">
      {n}
    </span>
  );
}

function MiniBoard() {
  // A tiny mockup of the opening board: only the center tile's 4 orthogonal
  // neighbors are legal on an empty board, exactly like the real thing.
  const legal = new Set(["1,0", "0,1", "2,1", "1,2"]);
  const cells: string[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) cells.push(`${x},${y}`);

  return (
    <div className="grid w-max grid-cols-3 gap-1">
      {cells.map((key) => {
        if (key === "1,1") {
          return (
            <div
              key={key}
              className="flex h-8 w-8 items-center justify-center rounded border-2 border-dashed border-zinc-400 text-[7px] text-zinc-400"
            >
              center
            </div>
          );
        }
        return (
          <div
            key={key}
            className={`h-8 w-8 rounded border ${
              legal.has(key)
                ? "border-emerald-300/70 bg-emerald-50/50 dark:border-emerald-800/70 dark:bg-emerald-950/40"
                : "border-zinc-200 dark:border-zinc-800"
            }`}
          />
        );
      })}
    </div>
  );
}

/** Real card data (name/base/text), not hardcoded copy that can drift out of sync with an actual rebalance -- this is Footman's CardDef, currently named Shieldbearer. */
function MiniCard() {
  const def = CARD_DEFS.Footman;
  return (
    <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-blue-500 bg-blue-50 p-1 text-center dark:bg-blue-950">
      <span className="text-[9px] font-semibold leading-tight">{def.name}</span>
      <span className="text-lg font-bold leading-none">{def.base}</span>
      <span className="text-[7px] leading-tight text-zinc-500 dark:text-zinc-400">{def.text}</span>
    </div>
  );
}

/**
 * Mirrors the real header panel's TurnOrderTracker (GameStatusPanel.tsx): the "Round
 * starts with X" caption in that player's color, plus a short player list with the
 * active turn highlighted -- same structure and classes, just fixed example names/seats
 * instead of live GameState, since this only needs to teach what the real widget means.
 */
function MiniTurnOrder() {
  const names = ["Alex", "Sam", "Jo"];
  const activeIdx = 1;
  const roundStartIdx = 0;
  return (
    <div className="flex w-36 shrink-0 flex-col gap-1 rounded-md border border-zinc-300 p-2 dark:border-zinc-700">
      <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Turn order</span>
      <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
        Round starts with <span className={`font-semibold ${PLAYER_TEXT_COLOR_CLASSES[roundStartIdx]}`}>{names[roundStartIdx]}</span>
      </span>
      <div className="flex flex-col gap-0.5">
        {names.map((name, i) => (
          <div
            key={name}
            className={`flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs ${
              i === activeIdx
                ? "border-emerald-500 bg-emerald-50 font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "border-transparent text-zinc-600 dark:text-zinc-400"
            }`}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${PLAYER_DOT_COLOR_CLASSES[i]}`} />
            <span className="min-w-0 flex-1 truncate">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Real center-effect data (label/description), not hardcoded copy -- "reckoning" is Hall of Fortunes. Mirrors Board.tsx's ownerless-tile rendering (dashed box with the label inside). */
function MiniCenterTile() {
  const effect = CENTER_EFFECTS.reckoning;
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border-2 border-dashed border-zinc-400 p-1 text-center text-[9px] leading-tight break-words text-zinc-400">
      {effect.label}
    </div>
  );
}

export function InstructionsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-zinc-300 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">How to play</h2>
          <button
            onClick={onClose}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Close
          </button>
        </div>

        <div className="space-y-5 text-sm">
          <section>
            <h3 className="mb-1 font-semibold">Goal</h3>
            <p className="text-zinc-600 dark:text-zinc-400">
              Place cards on the board to build the highest total score. Cards start face-down and are worth their
              base value plus effects from themselves or other cards — position, ownership, face-up status can all
              matter. Scores are only revealed at the very end.
            </p>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Your turn</h3>
            <ol className="space-y-2 text-zinc-600 dark:text-zinc-400">
              <li className="flex items-start gap-2">
                <StepBadge n={1} />
                <span>
                  <strong className="text-zinc-800 dark:text-zinc-200">Optionally flip</strong> one face-down card
                  face-up (once flipping unlocks).
                </span>
              </li>
              <li className="flex items-start gap-2">
                <StepBadge n={2} />
                <span>
                  <strong className="text-zinc-800 dark:text-zinc-200">Place one card</strong> from your hand onto a
                  highlighted cell — drag it there, or tap the card then tap the cell.
                </span>
              </li>
            </ol>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Turn order</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniTurnOrder />
              <p className="min-w-[16rem] flex-1 text-zinc-600 dark:text-zinc-400">
                Within a round, turns go in the same fixed order every time. If the game has 3+ players, the round
                leader (the first player to go each round) rotates by one seat each round. The right-hand panel&rsquo;s
                turn order list — shown here as an example — always shows who starts the current round, and
                highlights whoever&rsquo;s turn it is now.
              </p>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">The board</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniBoard />
              <p className="min-w-[16rem] flex-1 text-zinc-600 dark:text-zinc-400">
                Faint green cells are empty and legal to place on right now. A placement must be adjacent to an
                existing card or the center tile. Nothing goes on the center itself, but it always counts as a
                neighbor.
              </p>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Adjacency</h3>
            <p className="text-zinc-600 dark:text-zinc-400">
              &ldquo;Adjacent&rdquo; and &ldquo;neighbor&rdquo; always mean the same thing, everywhere in this game — both for where you&rsquo;re
              allowed to place, and for every card effect that reads either word: <strong className="text-zinc-800 dark:text-zinc-200">orthogonal only</strong> (same
              row or column, one cell over) — <strong className="text-zinc-800 dark:text-zinc-200">never diagonal</strong>. A card&rsquo;s short
              summary abbreviates this to <strong className="text-zinc-800 dark:text-zinc-200">&ldquo;adj.&rdquo;</strong> to save space — hover any card for
              the full, unabbreviated wording.
            </p>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Cards</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniCard />
              <ul className="min-w-[16rem] flex-1 list-disc space-y-1 pl-4 text-zinc-600 dark:text-zinc-400">
                <li>Name and base value, shown in your hand and once revealed.</li>
                <li>A short effect summary — hover any card (hand or board) for the full rules text.</li>
                <li>You can always see your own hand and any face-up card; opponents&rsquo; face-down cards stay hidden.</li>
              </ul>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Scoring</h3>
            <p className="text-zinc-600 dark:text-zinc-400">
              Nothing is scored during play. When the game ends, every card&rsquo;s final value is computed according
              to the state on the board. Highest total wins; ties share the win.
            </p>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Ending the game</h3>
            <ul className="list-disc space-y-1 pl-4 text-zinc-600 dark:text-zinc-400">
              <li>The round cap is reached, or</li>
              <li>
                Starting from the min-round floor, every round opens a private vote to end — it only ends if a
                majority says yes; ties keep the game going.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Center effects</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniCenterTile />
              <p className="min-w-[16rem] flex-1 text-zinc-600 dark:text-zinc-400">
                Each game picks one special rule for the center tile (or none) — shown in the header and on the
                center tile itself. For example, the Hall of Fortunes location shown here makes every player discard
                and redraw their hand at the start of round 4. Hover the center tile any time to see what it does.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
