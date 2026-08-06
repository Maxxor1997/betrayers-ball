"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { InstructionsModal } from "@/app/components/InstructionsModal";
import { CardCatalog } from "@/app/components/CardCatalog";
import { NewGameModal, NewGameSetup } from "@/app/components/NewGameModal";
import { createMultiplayerRoom } from "@/app/hooks/createMultiplayerRoom";
import { listMultiplayerRooms } from "@/app/hooks/listMultiplayerRooms";
import { loadCredentials } from "@/app/hooks/multiplayerCredentials";
import { CENTER_EFFECTS, randomCenterEffectPool } from "@/lib/content/centerEffects";
import { RoomSummary } from "@/lib/server/protocol";

/** Just a representative deck-count snapshot for the home screen's reference catalog -- there's no active game yet to derive a real player count from. */
const CATALOG_PLAYER_COUNT = 4;

function PlayOption({
  href,
  onClick,
  title,
  description,
}: {
  href?: string;
  onClick?: () => void;
  title: string;
  description: string;
}) {
  const className = "flex flex-col gap-1 rounded-xl border border-zinc-300 p-5 text-left transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900";

  // onClick (e.g. "Single player"/"Multiplayer", which open a setup popup here rather
  // than navigating straight off the home screen) takes a <button>; a plain
  // navigation takes a <Link>.
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

/**
 * Every room on this network, lobby or in-progress -- lets a player join (or, for a
 * started game, reconnect) without needing a direct link/room code. Includes started
 * games on purpose: someone who hit the "Home" link mid-game still has their seat's
 * credentials in this browser's sessionStorage (see multiplayerCredentials.ts), so
 * this is how they find their way back in. A started room this browser was never
 * seated in shows as a plain status, not a button -- clicking through would just hit
 * addPlayer's "already started" rejection on the join page, a dead end not worth
 * offering.
 */
function ActiveSessions() {
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    const result = await listMultiplayerRooms();
    setLoading(false);
    if ("error" in result) setError(result.error);
    else setRooms(result.rooms);
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-300 p-5 dark:border-zinc-700">
      <div className="flex items-center justify-between gap-2">
        <span className="text-base font-semibold">Active sessions</span>
        <button
          onClick={refresh}
          disabled={loading}
          className="shrink-0 rounded-full border border-zinc-300 px-3 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {rooms && rooms.length === 0 && !error && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No games on this network right now.</p>
      )}
      {rooms && rooms.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rooms.map((room) => {
            const canReconnect = room.started && loadCredentials(room.roomCode) !== null;
            const canJoin = !room.started;
            return (
              <li
                key={room.roomCode}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
              >
                <span className="min-w-0">
                  <span className="font-medium">{room.hostName}&rsquo;s game</span>{" "}
                  <span className="text-zinc-500 dark:text-zinc-400">
                    — {room.seatedCount}/{room.playerCount} players, {CENTER_EFFECTS[room.centerEffect].label}
                    {room.started && " · in progress"}
                  </span>
                </span>
                {canJoin || canReconnect ? (
                  <button
                    onClick={() => router.push(`/join/${room.roomCode}`)}
                    className="shrink-0 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black"
                  >
                    {canReconnect ? "Reconnect" : "Join"}
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">In progress</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [showInstructions, setShowInstructions] = useState(false);
  // Set as soon as "Single player" or "Multiplayer" is clicked -- stays on the home
  // screen (nothing navigates, no game/room exists yet) until Start is pressed, so the
  // destination page only ever mounts with a real, already-chosen setup, never a
  // placeholder the player didn't ask for.
  const [newGameSetup, setNewGameSetup] = useState<NewGameSetup | null>(null);
  const [mode, setMode] = useState<"solo" | "host">("solo");
  const [hostName, setHostName] = useState("");
  const [hostError, setHostError] = useState<string | null>(null);
  const [hosting, setHosting] = useState(false);

  function openSoloSetup() {
    setMode("solo");
    setHostError(null);
    setNewGameSetup({ playerCount: 2, centerEffect: "random" });
  }

  function openHostSetup() {
    setMode("host");
    setHostError(null);
    setNewGameSetup({ playerCount: 4, centerEffect: "random" });
  }

  function startSoloGame(setup: NewGameSetup) {
    const pool = randomCenterEffectPool(setup.playerCount);
    const centerEffect = setup.centerEffect === "random" ? pool[Math.floor(Math.random() * pool.length)] : setup.centerEffect;
    router.push(`/play?players=${setup.playerCount}&center=${centerEffect}`);
  }

  async function startHostedRoom(setup: NewGameSetup) {
    setHosting(true);
    setHostError(null);
    const pool = randomCenterEffectPool(setup.playerCount);
    const centerEffect = setup.centerEffect === "random" ? pool[Math.floor(Math.random() * pool.length)] : setup.centerEffect;
    const result = await createMultiplayerRoom(hostName.trim() || "Host", setup.playerCount, centerEffect);
    setHosting(false);
    if ("error" in result) {
      setHostError(result.error);
      return;
    }
    router.push(`/join/${result.roomCode}`);
  }

  function confirmNewGame() {
    if (!newGameSetup) return;
    if (mode === "solo") startSoloGame(newGameSetup);
    else startHostedRoom(newGameSetup);
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
        <NewGameModal
          title={mode === "host" ? "Host a multiplayer game" : "Start a new game"}
          setup={newGameSetup}
          onChange={setNewGameSetup}
          onCancel={() => setNewGameSetup(null)}
          onConfirm={confirmNewGame}
          confirmLabel={hosting ? "Starting…" : mode === "host" ? "Create room" : "Start"}
          nameField={mode === "host" ? { value: hostName, onChange: setHostName } : undefined}
          playerCountLabel={mode === "host" ? (n) => `${n}` : undefined}
        />
      )}

      {/* w-full, not max-w-4xl like the header -- CardCatalog is a fixed-width aside
          that should dock to the true left edge of the screen (matching the single-
          player board's left sidebar), not just the left edge of a centered column. */}
      <div className="flex w-full flex-1 flex-col gap-8 lg:flex-row lg:items-start">
        <CardCatalog playerCount={CATALOG_PLAYER_COUNT} />
        <div className="mx-auto flex w-full max-w-md min-w-0 flex-1 flex-col gap-4">
          <h2 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Play</h2>
          {hostError && <p className="text-xs text-red-600 dark:text-red-400">{hostError}</p>}
          <div className="flex flex-col gap-4">
            <PlayOption title="Single player" description="You vs. AI opponents, on this device." onClick={openSoloSetup} />
            <PlayOption
              title="Multiplayer"
              description="Host a game on this network; others join from their own browser."
              onClick={openHostSetup}
            />
            <ActiveSessions />
          </div>
        </div>
      </div>
    </div>
  );
}
