"use client";

import { CardArt } from "@/app/components/CardArt";
import { LocationArt } from "@/app/components/LocationArt";
import { BreakdownPopup } from "@/app/components/scoreBreakdown";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { roundRotationShiftFor } from "@/lib/engine/game";
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

/** Real card data (name/base/text), not hardcoded copy that can drift out of sync with an actual rebalance -- this is Footman's CardDef, currently named Hoplite. Same name/art/base/text stack a real board or hand card renders, and square like a real one too. line-clamp-3 + overflow-hidden is a backstop for whichever card ends up here after a future rebalance -- Hoplite's own text fits without it kicking in at this size. */
function MiniCard() {
  const def = CARD_DEFS.Footman;
  return (
    <div className="flex h-22 w-22 shrink-0 flex-col items-center justify-start gap-0.5 rounded-md border-2 border-blue-500 bg-blue-50 p-1.5 text-center dark:bg-blue-950">
      <span className="w-full text-[9px] leading-tight font-semibold break-words">{def.name}</span>
      <CardArt cardId={def.id} className="h-5 w-5 shrink-0" />
      <span className="text-lg leading-none font-bold">{def.base}</span>
      <span className="line-clamp-3 w-full overflow-hidden text-[7px] leading-tight break-words text-zinc-500 dark:text-zinc-400">
        {def.text}
      </span>
    </div>
  );
}

/**
 * Mirrors the real header panel's TurnOrderTracker (GameStatusPanel.tsx): the "Round
 * starts with X"/"Next round starts with X" captions in that player's color, plus a
 * short player list with the active turn highlighted -- same structure and classes,
 * just fixed example names/seats instead of live GameState, since this only needs to
 * teach what the real widget means. roundRotationShiftFor is the real engine function
 * (not a hardcoded "+1 seat"), so this stays correct if that tuning ever changes.
 */
function MiniTurnOrder() {
  const names = ["Alex", "Sam", "Jo"];
  const activeIdx = 1;
  const roundStartIdx = 0;
  const nextRoundStartIdx = (roundStartIdx + roundRotationShiftFor(names.length)) % names.length;
  // The real tracker only ever shows the *last fully tallied* round's votes
  // (voteHistory), and a round only tallies once every player has voted -- so it's
  // never actually possible to see one player with a glyph and another without one
  // from the same round; it's either nobody yet (no round has completed) or everybody
  // at once. This example shows all three voted, one of each letter/color, so both
  // glyphs are still demonstrated without implying a partial-vote state that can't
  // really happen -- same VoteGlyph letters/colors/meanings as the real
  // GameStatusPanel.tsx.
  const votes: (boolean | undefined)[] = [true, true, false];
  return (
    <div className="flex w-36 shrink-0 flex-col gap-1 rounded-md border border-zinc-300 p-2 dark:border-zinc-700">
      <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Turn order</span>
      <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
        Round starts with <span className={`font-semibold ${PLAYER_TEXT_COLOR_CLASSES[roundStartIdx]}`}>{names[roundStartIdx]}</span>
      </span>
      <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
        Next round starts with{" "}
        <span className={`font-semibold ${PLAYER_TEXT_COLOR_CLASSES[nextRoundStartIdx]}`}>{names[nextRoundStartIdx]}</span>
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
            {votes[i] !== undefined &&
              (votes[i] ? (
                <span className="text-[10px] font-bold text-rose-600 dark:text-rose-400">E</span>
              ) : (
                <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">C</span>
              ))}
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
    <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border-2 border-dashed border-zinc-400 p-1 text-center text-[9px] leading-tight break-words text-zinc-400">
      <LocationArt id="reckoning" className={`h-6 w-6 shrink-0 ${effect.themeColorClass}`} />
      {effect.label}
    </div>
  );
}

/**
 * Mirrors the real end-of-round vote prompt (join/[code]/page.tsx's GameView) --
 * same copy, layout, and button treatment, just rendered inline (no `fixed`
 * positioning, which would escape this modal) and inert (no onClick -- these buttons
 * don't do anything here, so they're plain divs, not real <button>s, to keep an
 * unusable control out of the tab order).
 */
function MiniVotePrompt() {
  return (
    <div className="w-56 shrink-0 rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      <p className="mb-2 font-medium">Vote: end the game now?</p>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
        Round 4 of 6. Everyone votes privately; a majority is needed to end (ties continue).
      </p>
      <div className="flex justify-end gap-2">
        <div className="rounded-full border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-700">Keep playing</div>
        <div className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black">End game</div>
      </div>
    </div>
  );
}

/**
 * Mirrors the real per-card score breakdown popup (Board.tsx/EndScreen.tsx/
 * GameStatusPanel.tsx all render the same shared BreakdownPopup) -- same component,
 * same dark/light popup treatment, just fed an illustrative fixed breakdown instead of
 * a live ResolvedCard, since there's no real board here to resolve. Hoplite (Footman)
 * again, same card as MiniCard above, so its rule and this example agree with each
 * other: base 5, +1 for the "unbroken line of 3+ owned" bonus its own rule describes.
 */
function MiniScoreSummary() {
  const def = CARD_DEFS.Footman;
  const finalValue = def.base + 1;
  return (
    <div className="w-56 shrink-0 rounded-lg bg-zinc-900 p-3 text-white shadow-lg dark:bg-zinc-100 dark:text-black">
      <p className="mb-1 text-xs font-semibold">{def.name}</p>
      <div className="text-[11px]">
        <BreakdownPopup
          breakdown={[
            { label: "Base", amount: def.base },
            { label: `${def.name} (unbroken line of 3+ owned)`, amount: 1 },
          ]}
          finalValue={finalValue}
        />
      </div>
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
          <h2 className="text-lg font-semibold">Rules</h2>
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
              Place cards on the board to build the highest total score. Cards start <strong className="text-zinc-800 dark:text-zinc-200">face-down</strong> and are worth their
              base value plus effects from themselves or other cards — position, ownership, face-up status can all
              matter. Scores are only calculated at the end of the game.
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
            <h3 className="mb-1 font-semibold">The board</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniBoard />
              <div className="min-w-[16rem] flex-1 space-y-2 text-zinc-600 dark:text-zinc-400">
                <p>
                  Faint green cells are empty and legal to place on right now. A placement must be adjacent to an
                  existing card or the center tile. Nothing can be placed on the center, but it always counts as a
                  face-up card.
                </p>
                <p>
                  <strong className="text-zinc-800 dark:text-zinc-200">Adjacency</strong> — &ldquo;Adjacent&rdquo;
                  always means the same thing in this game:{" "}
                  <strong className="text-zinc-800 dark:text-zinc-200">orthogonal only</strong> (same row or column,
                  one cell over) — never diagonal. A
                  card&rsquo;s short summary abbreviates this to{" "}
                  <strong className="text-zinc-800 dark:text-zinc-200">&ldquo;adj.&rdquo;</strong> to save space.
                </p>
              </div>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Cards</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniCard />
              <ul className="min-w-[16rem] flex-1 list-disc space-y-1 pl-4 text-zinc-600 dark:text-zinc-400">
                <li>Name and base value, shown in your hand and on the board once revealed.</li>
                <li>A short effect summary — hover any card in the Card catalog for the full rules text.</li>
                <li>You can always see your own hand and any face-up card; opponents&rsquo; face-down cards stay hidden.</li>
              </ul>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Scoring</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniScoreSummary />
              <p className="min-w-[16rem] flex-1 text-zinc-600 dark:text-zinc-400">
                When the game ends, every card&rsquo;s final value is computed
                according to the state on the board. The player with the highest total combined across their cards wins; ties share the win. Hover (or tap) any card
                once the game has ended to see a breakdown like this one.
              </p>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Turn order</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniTurnOrder />
              <p className="min-w-[16rem] flex-1 text-zinc-600 dark:text-zinc-400">
                The round leader (the first player to play) rotates each round. The right-hand panel&rsquo;s turn
                order list — shown here as an example — always shows who starts the current round, who starts the
                next round, and highlights whoever&rsquo;s turn it is now. Once voting opens, an{" "}
                <strong className="text-zinc-800 dark:text-zinc-200">E</strong> or{" "}
                <strong className="text-zinc-800 dark:text-zinc-200">C</strong> appears next to each player who&rsquo;s
                cast their vote for the round to <strong className="text-zinc-800 dark:text-zinc-200">e</strong>nd or{" "}
                <strong className="text-zinc-800 dark:text-zinc-200">c</strong>ontinue.
              </p>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Ending the game</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniVotePrompt />
              <ul className="min-w-[16rem] flex-1 list-disc space-y-1 pl-4 text-zinc-600 dark:text-zinc-400">
                <li>The round cap is reached, or</li>
                <li>
                  Starting from the min-round floor, every round opens a private vote to end — shown as a popup like
                  this one — it only ends if a <strong className="text-zinc-800 dark:text-zinc-200">majority</strong> of players vote to end (the game continues if there is a tie).
                </li>
              </ul>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Center effects</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniCenterTile />
              <p className="min-w-[16rem] flex-1 text-zinc-600 dark:text-zinc-400">
                Each game will have a location with a unique effect — shown in the header and on the
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
