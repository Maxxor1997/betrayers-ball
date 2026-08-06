"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { InstructionsModal } from "@/app/components/InstructionsModal";
import { CardCatalog } from "@/app/components/CardCatalog";
import { NewGameModal, NewGameSetup } from "@/app/components/NewGameModal";
import { randomCenterEffectPool } from "@/lib/content/centerEffects";

/** Just a representative deck-count snapshot for the home screen's reference catalog -- there's no active game yet to derive a real player count from. */
const CATALOG_PLAYER_COUNT = 4;

function PlayOption({
  href,
  onClick,
  title,
  description,
  disabled,
}: {
  href?: string;
  onClick?: () => void;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  const className = `flex flex-col gap-1 rounded-xl border p-5 text-left transition-colors ${
    disabled
      ? "cursor-not-allowed border-zinc-200 opacity-50 dark:border-zinc-800"
      : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
  }`;

  if (disabled) {
    // A genuinely dead link -- not wired to any route yet -- rather than a real Link
    // to a page that doesn't exist.
    return (
      <a href="#" onClick={(e) => e.preventDefault()} className={className}>
        <span className="text-base font-semibold">{title}</span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{description}</span>
        <span className="mt-1 w-max rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-zinc-600 uppercase dark:bg-zinc-800 dark:text-zinc-400">
          Coming soon
        </span>
      </a>
    );
  }

  // onClick (e.g. "Single player", which opens the setup popup here rather than
  // navigating straight to /play) takes a <button>; a plain navigation takes a <Link>.
  if (onClick) {
    return (
      <button onClick={onClick} className={className}>
        <span className="text-base font-semibold">{title}</span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{description}</span>
      </button>
    );
  }

  return (
    <Link href={href!} className={className}>
      <span className="text-base font-semibold">{title}</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">{description}</span>
    </Link>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [showInstructions, setShowInstructions] = useState(false);
  // Set as soon as "Single player" is clicked -- stays on the home screen (nothing
  // navigates, no game exists yet) until Start is pressed, so /play only ever mounts
  // with a real, already-chosen setup, never a placeholder game the player didn't ask for.
  const [newGameSetup, setNewGameSetup] = useState<NewGameSetup | null>(null);

  function startGame() {
    if (!newGameSetup) return;
    const pool = randomCenterEffectPool(newGameSetup.playerCount);
    const centerEffect = newGameSetup.centerEffect === "random" ? pool[Math.floor(Math.random() * pool.length)] : newGameSetup.centerEffect;
    router.push(`/play?players=${newGameSetup.playerCount}&center=${centerEffect}`);
  }

  return (
    <div className="flex flex-1 flex-col items-center gap-8 px-4 py-8">
      <header className="flex w-full max-w-4xl flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Board Game</h1>
        <div className="flex flex-wrap items-center gap-3">
          <ThemeToggle />
          <button
            onClick={() => setShowInstructions(true)}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            How to play
          </button>
        </div>
      </header>

      {showInstructions && <InstructionsModal onClose={() => setShowInstructions(false)} />}

      {newGameSetup && (
        <NewGameModal setup={newGameSetup} onChange={setNewGameSetup} onCancel={() => setNewGameSetup(null)} onConfirm={startGame} />
      )}

      {/* w-full, not max-w-4xl like the header -- CardCatalog is a fixed-width aside
          that should dock to the true left edge of the screen (matching the single-
          player board's left sidebar), not just the left edge of a centered column. */}
      <div className="flex w-full flex-1 flex-col gap-8 lg:flex-row lg:items-start">
        <CardCatalog playerCount={CATALOG_PLAYER_COUNT} />
        <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-1 flex-col gap-4">
          <h2 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Play</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <PlayOption
              title="Single player"
              description="You vs. AI opponents, on this device."
              onClick={() => setNewGameSetup({ playerCount: 2, centerEffect: "random" })}
            />
            <PlayOption title="Multiplayer (desktop)" description="Shared screen + phone controllers." disabled />
            <PlayOption title="Multiplayer (mobile)" description="Play entirely from your phone." disabled />
          </div>
        </div>
      </div>
    </div>
  );
}
