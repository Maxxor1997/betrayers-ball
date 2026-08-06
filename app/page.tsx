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
import { isMobileViewport } from "@/app/hooks/isMobileViewport";
import { useDefaultCollapsed } from "@/app/hooks/useDefaultCollapsed";
import { CENTER_EFFECTS, randomCenterEffectPool } from "@/lib/content/centerEffects";
import { RoomSummary } from "@/lib/server/protocol";

/** Just a representative deck-count snapshot for the home screen's reference catalog -- there's no active game yet to derive a real player count from. */
const CATALOG_PLAYER_COUNT = 4;

/** Small stroke icons for each play option -- 20x20, currentColor, no external assets. */
function SoloIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <circle cx="10" cy="6.5" r="3.25" />
      <path d="M3.5 17c0-3.2 2.9-5.5 6.5-5.5s6.5 2.3 6.5 5.5" strokeLinecap="round" />
    </svg>
  );
}
function MultiplayerIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <circle cx="7" cy="6.5" r="2.75" />
      <circle cx="14.5" cy="8" r="2.1" />
      <path d="M2 17c0-2.9 2.2-5 5-5s5 2.1 5 5" strokeLinecap="round" />
      <path d="M12.7 12.3c2.2.2 3.8 2 3.8 4.4" strokeLinecap="round" />
    </svg>
  );
}
function ScreencastIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <rect x="2.5" y="4" width="15" height="10" rx="1.5" />
      <path d="M7.5 17.5h5" strokeLinecap="round" />
      <path d="M7.5 10.5l2.8-1.7 2.7 1.7V6.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PlaytestIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <path d="M5 15.5V11M10 15.5V6M15 15.5v-6.5" strokeLinecap="round" />
      <path d="M2.5 17.5h15" strokeLinecap="round" />
    </svg>
  );
}

function PlayOption({
  href,
  onClick,
  title,
  description,
  icon,
  accentClass,
}: {
  href?: string;
  onClick?: () => void;
  title: string;
  description: string;
  icon: React.ReactNode;
  /** Precomputed Tailwind classes for the icon badge, passed whole (not built from a color name) so Tailwind's build-time scanner sees the literal class names. */
  accentClass: string;
}) {
  const className =
    "group flex h-full items-start gap-3 rounded-xl border border-zinc-300 p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-zinc-400 hover:shadow-md dark:border-zinc-700 dark:hover:border-zinc-600";
  const content = (
    <>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${accentClass}`}>{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-base font-semibold">{title}</span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{description}</span>
      </span>
    </>
  );

  // onClick (e.g. "Single player"/"Multiplayer", which open a setup popup here rather
  // than navigating straight off the home screen) takes a <button>; a plain
  // navigation takes a <Link>.
  if (onClick) {
    return (
      <button onClick={onClick} className={className}>
        {content}
      </button>
    );
  }

  return (
    <Link href={href!} className={className}>
      {content}
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
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-300 p-4 shadow-sm dark:border-zinc-700">
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
                  <span className="font-medium">{room.hostIsDisplay ? "Game on a shared screen" : `${room.hostName}’s game`}</span>{" "}
                  <span className="text-zinc-500 dark:text-zinc-400">
                    — {room.seatedCount}/{room.playerCount} players, {CENTER_EFFECTS[room.centerEffect].label}
                    {room.started && " · in progress"}
                  </span>
                </span>
                {canJoin || canReconnect ? (
                  <button
                    onClick={() => router.push(`${room.hostIsDisplay && canReconnect ? "/host" : "/join"}/${room.roomCode}`)}
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
  const [mode, setMode] = useState<"solo" | "host" | "display">("solo");
  const [hostName, setHostName] = useState("");
  const [hostError, setHostError] = useState<string | null>(null);
  const [hosting, setHosting] = useState(false);
  // Starts false (SSR-safe -- window isn't available yet) and corrects itself once
  // mounted; useDefaultCollapsed only ever applies this once, so the brief
  // false->true flip on phones doesn't fight a manual toggle.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => setIsMobile(isMobileViewport()), []);
  const [cardsCollapsed, setCardsCollapsed] = useDefaultCollapsed(isMobile);

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

  function openDisplaySetup() {
    setMode("display");
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

  /** Jackbox-style: this device takes no seat, just displays the board -- every real player joins from their own phone via /join/[code]. See createMultiplayerRoom's asDisplay flag. */
  async function startDisplayRoom(setup: NewGameSetup) {
    setHosting(true);
    setHostError(null);
    const pool = randomCenterEffectPool(setup.playerCount);
    const centerEffect = setup.centerEffect === "random" ? pool[Math.floor(Math.random() * pool.length)] : setup.centerEffect;
    const result = await createMultiplayerRoom("Host", setup.playerCount, centerEffect, true);
    setHosting(false);
    if ("error" in result) {
      setHostError(result.error);
      return;
    }
    router.push(`/host/${result.roomCode}`);
  }

  function confirmNewGame() {
    if (!newGameSetup) return;
    if (mode === "solo") startSoloGame(newGameSetup);
    else if (mode === "host") startHostedRoom(newGameSetup);
    else startDisplayRoom(newGameSetup);
  }

  return (
    // CardCatalog is the first child of this row (not a sibling below a full-width
    // header), same structure /play uses -- it's a `lg:self-start` sidebar that spans
    // the row's full height, so it sits flush against the true left edge alongside
    // the header too, not just alongside the content underneath it.
    <div className="flex flex-1 flex-col gap-8 px-4 py-8 lg:flex-row lg:items-start">
      <CardCatalog playerCount={CATALOG_PLAYER_COUNT} collapsed={cardsCollapsed} onCollapsedChange={setCardsCollapsed} />
      <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-1 flex-col items-center gap-8">
        <header className="flex w-full flex-col gap-2">
          <div className="flex w-full items-center justify-between gap-2">
            <h1 className="text-lg font-semibold sm:text-xl">Board Game</h1>
            <ThemeToggle />
          </div>
          <div className="flex w-full flex-wrap items-center gap-1.5">
            <button
              onClick={() => setCardsCollapsed(!cardsCollapsed)}
              className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {cardsCollapsed ? "▶" : "◀"} Cards
            </button>
            <button
              onClick={() => setShowInstructions(true)}
              className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              How to play
            </button>
          </div>
        </header>

        {showInstructions && <InstructionsModal onClose={() => setShowInstructions(false)} />}

        {newGameSetup && (
          <NewGameModal
            title={mode === "host" ? "Host a multiplayer game" : mode === "display" ? "Cast to this screen" : "Start a new game"}
            setup={newGameSetup}
            onChange={setNewGameSetup}
            onCancel={() => setNewGameSetup(null)}
            onConfirm={confirmNewGame}
            confirmLabel={hosting ? "Starting…" : mode === "host" ? "Create room" : mode === "display" ? "Open display" : "Start"}
            nameField={mode === "host" ? { value: hostName, onChange: setHostName } : undefined}
            playerCountLabel={mode === "host" ? (n) => `${n}` : mode === "display" ? (n) => `${n} players` : undefined}
          />
        )}

        <div className="flex w-full flex-col gap-4">
          <h2 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Play</h2>
          {hostError && <p className="text-xs text-red-600 dark:text-red-400">{hostError}</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PlayOption
              title="Singleplayer"
              description="You vs. AI opponents, on this device."
              icon={<SoloIcon />}
              accentClass="bg-sky-100 text-sky-600 dark:bg-sky-950 dark:text-sky-400"
              onClick={openSoloSetup}
            />
            <PlayOption
              title="Multiplayer"
              description="Host a game on this network; others join from their own browser."
              icon={<MultiplayerIcon />}
              accentClass="bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400"
              onClick={openHostSetup}
            />
            <PlayOption
              title="Screencast"
              description="This device shows the board only, no hand of its own -- everyone else joins from their phone."
              icon={<ScreencastIcon />}
              accentClass="bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
              onClick={openDisplaySetup}
            />
            <PlayOption
              href="/playtest"
              title="Playtest"
              description="Simulate large numbers of AI-only games (or play one yourself) and tally per-card scoring/placement stats."
              icon={<PlaytestIcon />}
              accentClass="bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400"
            />
          </div>
          <ActiveSessions />
        </div>
      </div>
    </div>
  );
}
