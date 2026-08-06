"use client";

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

function MiniCard() {
  return (
    <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-blue-500 bg-blue-50 p-1 text-center dark:bg-blue-950">
      <span className="text-[9px] font-semibold leading-tight">Footman</span>
      <span className="text-lg font-bold leading-none">5</span>
      <span className="text-[7px] leading-tight text-zinc-500 dark:text-zinc-400">+1 if 3+ owned in row/col</span>
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
              base value plus whatever their effect adds or subtracts — position, ownership, and who's face-up all
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
                  face-up (once flipping unlocks) — at most one per turn, and it's permanent.
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
              <p className="max-w-xs text-zinc-600 dark:text-zinc-400">
                Faint green cells are empty and legal to place on right now — they're not cards, just open targets. A
                placement must be orthogonally adjacent to an existing card or the center tile — nothing goes on the
                center itself, but it always counts as a neighbor.
              </p>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Cards</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniCard />
              <ul className="max-w-xs list-disc space-y-1 pl-4 text-zinc-600 dark:text-zinc-400">
                <li>Name and base value, shown in your hand and once revealed.</li>
                <li>A short effect summary — hover any card (hand or board) for the full rules text.</li>
                <li>You can always see your own hand and any face-up card; opponents' face-down cards stay hidden.</li>
              </ul>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Scoring</h3>
            <p className="text-zinc-600 dark:text-zinc-400">
              Nothing is scored during play. When the game ends, every card's final value is computed at once from
              its base value plus its effect — adjacency, ownership, and flip-state all feed in, but never another
              card's already-modified value. Highest total wins; ties share the win.
            </p>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Ending the game</h3>
            <ul className="list-disc space-y-1 pl-4 text-zinc-600 dark:text-zinc-400">
              <li>The board fills up, or</li>
              <li>The round cap is reached, or</li>
              <li>
                Starting from the min-round floor, every round opens a private vote to end — it only ends if a
                majority says yes; ties keep the game going.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Center effects</h3>
            <p className="text-zinc-600 dark:text-zinc-400">
              Each game picks one special rule for the center tile (or none) — shown in the header and on the
              center tile itself. Hover the center tile any time to see what it does.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
