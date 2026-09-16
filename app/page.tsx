"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { InstructionsModal } from "@/app/components/InstructionsModal";
import { CardCatalog } from "@/app/components/CardCatalog";
import { LocationCatalog } from "@/app/components/LocationCatalog";
import { NewGameModal, NewGameSetup } from "@/app/components/NewGameModal";
import { DEFAULT_AI_DIFFICULTY } from "@/lib/ai/difficulty";
import { MultiplayerUnavailableBanner, MultiplayerUnavailableModal } from "@/app/components/MultiplayerUnavailableNotice";
import { createMultiplayerRoom } from "@/app/hooks/createMultiplayerRoom";
import { listMultiplayerRooms } from "@/app/hooks/listMultiplayerRooms";
import { loadCredentials } from "@/app/hooks/multiplayerCredentials";
import { isLocalRoom } from "@/app/hooks/localRooms";
import { useIsMobileOnMount } from "@/app/hooks/useIsMobileOnMount";
import { useDefaultCollapsed } from "@/app/hooks/useDefaultCollapsed";
import { CENTER_EFFECTS, randomCenterEffectPool } from "@/lib/content/centerEffects";
import { RoomSummary } from "@/lib/server/protocol";

/** Default player count for the home screen's reference catalog -- there's no active game yet to derive a real one from. The catalog's own header lets a visitor switch it to preview deck counts/locations at any size. */
const DEFAULT_CATALOG_PLAYER_COUNT = 4;

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
function ArenaIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <path d="M6 3.5h8L17 8v4l-3 4.5H6L3 12V8z" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2" />
    </svg>
  );
}
function SandboxIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
      <path d="M8 2.5h4M8.5 2.5v4l-4.3 7.4c-.6 1 .1 2.3 1.3 2.3h9c1.2 0 1.9-1.3 1.3-2.3L11.5 6.5v-4" strokeLinejoin="round" />
      <path d="M6.5 12h7" strokeLinecap="round" />
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
  fullWidth,
}: {
  href?: string;
  onClick?: () => void;
  title: string;
  description: string;
  icon: React.ReactNode;
  /** Precomputed Tailwind classes for the icon badge, passed whole (not built from a color name) so Tailwind's build-time scanner sees the literal class names. */
  accentClass: string;
  /** Spans both columns of the sm:grid-cols-2 grid -- for a trailing odd-one-out tile that would otherwise sit alone, half-width, looking like a mistake rather than a deliberate option. */
  fullWidth?: boolean;
}) {
  const className = `group flex h-full items-start gap-3 rounded-xl border border-zinc-300 p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-zinc-400 hover:shadow-md dark:border-zinc-700 dark:hover:border-zinc-600 ${
    fullWidth ? "sm:col-span-2" : ""
  }`;
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
 * Rooms this browser has actually touched (created or joined -- see localRooms.ts),
 * lobby or in-progress, filtered client-side out of the server's full room list. Lets
 * a player rejoin without needing to re-find a direct link/room code. Includes started
 * games on purpose: someone who hit the "Home" link mid-game still has their seat's
 * credentials in this browser's sessionStorage (see multiplayerCredentials.ts), so
 * this is how they find their way back in. A started room this browser was never
 * seated in shows as a plain status, not a button -- clicking through would just hit
 * addPlayer's "already started" rejection on the join page, a dead end not worth
 * offering.
 *
 * Deliberately NOT "every room on this network": the server's room registry is shared
 * by every visitor to a given deployment (see rooms.ts), and this app now runs both as
 * a LAN desktop and on a public Render deployment -- an unfiltered list there would
 * hand every visitor a live directory of every stranger's game.
 */
function ActiveSessions() {
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinCodeError, setJoinCodeError] = useState<string | null>(null);
  const [checkingJoinCode, setCheckingJoinCode] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    const result = await listMultiplayerRooms();
    setLoading(false);
    if ("error" in result) setError(result.error);
    else setRooms(result.rooms.filter((room) => isLocalRoom(room.roomCode)));
  }

  /**
   * Checks the code against the server's real room registry before navigating --
   * without this, a typo or an already-ended room would still land on
   * /join/[code]'s name-entry screen (it has no way to tell "room doesn't exist" from
   * "room exists, I just haven't joined it yet" until you actually submit a name), a
   * dead end that looks like a login prompt for a room that was never there.
   */
  async function handleJoinByCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setCheckingJoinCode(true);
    setJoinCodeError(null);
    const result = await listMultiplayerRooms();
    setCheckingJoinCode(false);
    if ("error" in result) {
      setJoinCodeError(result.error);
      return;
    }
    const room = result.rooms.find((r) => r.roomCode.toUpperCase() === code);
    if (!room) {
      setJoinCodeError(`No room found with code "${code}".`);
      return;
    }
    // Same "already started" rejection /join/[code]'s own NameEntry screen would
    // eventually surface, just one screen earlier -- catching it here avoids the
    // dead-end navigate-then-error round trip. Still lets a returning player back into
    // a started room they already hold credentials for (a real rejoin, not a fresh
    // join attempt) -- same canReconnect check the Active Sessions list below uses.
    if (room.started && loadCredentials(code) === null) {
      setJoinCodeError("This game has already started.");
      return;
    }
    router.push(`/join/${code}`);
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

      {error && <MultiplayerUnavailableBanner />}
      {rooms && rooms.length === 0 && !error && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No games you&apos;ve created or joined from this browser right now.</p>
      )}
      {rooms && rooms.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rooms.map((room) => {
            const canReconnect = room.started && loadCredentials(room.roomCode) !== null;
            const canJoin = !room.started;
            const isHost = loadCredentials(room.roomCode)?.playerId === room.hostPlayerId;
            return (
              <li
                key={room.roomCode}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {isHost && (
                    <span className="shrink-0 rounded-full border border-zinc-300 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:border-zinc-700 dark:text-zinc-400">
                      Host
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="font-medium">{room.hostIsDisplay ? "Game on a shared screen" : `${room.hostName}’s game`}</span>{" "}
                    <span className="text-zinc-500 dark:text-zinc-400">
                      — {room.seatedCount}/{room.playerCount} players, {CENTER_EFFECTS[room.centerEffect].label}
                      {room.started && " · in progress"}
                      {room.hasPassword && " · 🔒"}
                    </span>
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

      {/* Below the list, not folded into it -- this is how a browser that's never
          touched a given room gets in (a stranger clicking a shared link never sees
          this screen at all, but the same host handing out a bare room code, e.g. over
          voice, needs somewhere to type it), so it always shows regardless of whether
          the local-only list above is empty. */}
      <form onSubmit={handleJoinByCode} className="flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={joinCode}
            // Uppercased as typed -- room codes are always displayed/stored uppercase
            // (see roomWords.ts's randomRoomCode), and the submit handler already
            // uppercases before checking/navigating, so this just makes what's on
            // screen match that from the first keystroke instead of only once submitted.
            onChange={(e) => {
              setJoinCode(e.target.value.toUpperCase());
              setJoinCodeError(null);
            }}
            placeholder="Have a room code?"
            maxLength={24}
            className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm uppercase dark:border-zinc-700"
          />
          <button
            type="submit"
            disabled={!joinCode.trim() || checkingJoinCode}
            className="shrink-0 rounded-full bg-zinc-900 px-3 py-1.5 text-xs whitespace-nowrap text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
          >
            {checkingJoinCode ? "Checking…" : "Join"}
          </button>
        </div>
        {joinCodeError && <p className="text-xs text-red-600 dark:text-red-400">{joinCodeError}</p>}
      </form>
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
  const [roomPassword, setRoomPassword] = useState("");
  const [hostError, setHostError] = useState<string | null>(null);
  const [hosting, setHosting] = useState(false);
  // Starts false (SSR-safe -- window isn't available yet) and corrects itself once
  // mounted; useDefaultCollapsed only ever applies this once, so the brief
  // false->true flip on phones doesn't fight a manual toggle.
  const isMobile = useIsMobileOnMount();
  const [cardsCollapsed, setCardsCollapsed] = useDefaultCollapsed(isMobile);
  // Cards and Locations share the same sidebar slot and are mutually exclusive --
  // see openCards/openLocations below, which each close the other whenever they
  // open theirs, rather than the two ever trying to show side by side.
  const [locationsCollapsed, setLocationsCollapsed] = useDefaultCollapsed(true);
  function openCards() {
    const next = !cardsCollapsed;
    setCardsCollapsed(next);
    if (!next) setLocationsCollapsed(true);
  }
  function openLocations() {
    const next = !locationsCollapsed;
    setLocationsCollapsed(next);
    if (!next) setCardsCollapsed(true);
  }
  const [catalogPlayerCount, setCatalogPlayerCount] = useState(DEFAULT_CATALOG_PLAYER_COUNT);

  function openSoloSetup() {
    setMode("solo");
    setHostError(null);
    setNewGameSetup({ playerCount: 4, centerEffect: "random", aiDifficulty: DEFAULT_AI_DIFFICULTY });
  }

  function openHostSetup() {
    setMode("host");
    setHostError(null);
    setRoomPassword("");
    setNewGameSetup({ playerCount: 4, centerEffect: "random", aiDifficulty: DEFAULT_AI_DIFFICULTY });
  }

  function openDisplaySetup() {
    setMode("display");
    setHostError(null);
    setRoomPassword("");
    setNewGameSetup({ playerCount: 4, centerEffect: "random", aiDifficulty: DEFAULT_AI_DIFFICULTY });
  }

  function startSoloGame(setup: NewGameSetup) {
    // "random" passes straight through, unresolved -- /play does its own resolution
    // (see readGameSetupFromQuery's doc comment there) so it can tell "randomly
    // picked" apart from "deliberately fixed" for its own "Play again" rerolling.
    router.push(`/play?players=${setup.playerCount}&center=${setup.centerEffect}&difficulty=${setup.aiDifficulty}`);
  }

  async function startHostedRoom(setup: NewGameSetup) {
    setHosting(true);
    setHostError(null);
    const pool = randomCenterEffectPool(setup.playerCount);
    const centerEffect = setup.centerEffect === "random" ? pool[Math.floor(Math.random() * pool.length)] : setup.centerEffect;
    const result = await createMultiplayerRoom(
      hostName.trim() || "Host",
      setup.playerCount,
      centerEffect,
      setup.aiDifficulty,
      false,
      roomPassword,
      setup.centerEffect
    );
    setHosting(false);
    if ("error" in result) {
      setNewGameSetup(null);
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
    const result = await createMultiplayerRoom("Host", setup.playerCount, centerEffect, setup.aiDifficulty, true, roomPassword, setup.centerEffect);
    setHosting(false);
    if ("error" in result) {
      setNewGameSetup(null);
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
      <CardCatalog
        playerCount={catalogPlayerCount}
        onPlayerCountChange={setCatalogPlayerCount}
        collapsed={cardsCollapsed}
        onCollapsedChange={(next) => {
          setCardsCollapsed(next);
          if (!next) setLocationsCollapsed(true);
        }}
      />
      <LocationCatalog
        playerCount={catalogPlayerCount}
        onPlayerCountChange={setCatalogPlayerCount}
        collapsed={locationsCollapsed}
        onCollapsedChange={(next) => {
          setLocationsCollapsed(next);
          if (!next) setCardsCollapsed(true);
        }}
      />
      <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-1 flex-col items-center gap-8">
        <header className="flex w-full flex-col gap-5">
          <div className="flex w-full items-center justify-between gap-2">
            <h1 className="font-serif text-3xl leading-none font-bold tracking-tight sm:text-4xl">
              <span className="text-red-700 dark:text-red-500">Betrayer&apos;s </span>
              <span className="text-zinc-900 dark:text-zinc-50">Ball</span>
            </h1>
            <ThemeToggle />
          </div>
          <div className="flex w-full flex-wrap items-center gap-1.5">
            <button
              onClick={openCards}
              className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {cardsCollapsed ? "▶" : "◀"} Cards
            </button>
            <button
              onClick={openLocations}
              className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {locationsCollapsed ? "▶" : "◀"} <span className="sm:hidden">Loc.</span>
              <span className="hidden sm:inline">Locations</span>
            </button>
            <button
              onClick={() => setShowInstructions(true)}
              className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Rules
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
            passwordField={mode === "host" || mode === "display" ? { value: roomPassword, onChange: setRoomPassword } : undefined}
            playerCountLabel={mode === "host" ? (n) => `${n}` : mode === "display" ? (n) => `${n} players` : undefined}
            seatFillNote={mode === "solo" ? undefined : "Any empty seats are filled with AI once the game starts."}
          />
        )}

        {hostError && <MultiplayerUnavailableModal onClose={() => setHostError(null)} message={hostError} />}

        <div className="flex w-full flex-col gap-4">
          <h2 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Play</h2>
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
              description="This device shows the board only -- everyone else joins from their phone."
              icon={<ScreencastIcon />}
              accentClass="bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
              onClick={openDisplaySetup}
            />
            <PlayOption
              href="/playtest"
              title="Card Balance"
              description="Simulate large numbers of AI games and tally per-card stats."
              icon={<PlaytestIcon />}
              accentClass="bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400"
            />
            <PlayOption
              href="/playtest/arena"
              title="AI Arena"
              description="Pit AI difficulties and configurations against each other."
              icon={<ArenaIcon />}
              accentClass="bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-400"
            />
            <PlayOption
              href="/sandbox"
              title="Sandbox"
              description="Place any card anywhere, flip freely, and preview animations and scoring."
              icon={<SandboxIcon />}
              accentClass="bg-teal-100 text-teal-600 dark:bg-teal-950 dark:text-teal-400"
            />
          </div>
          <ActiveSessions />
        </div>
      </div>
    </div>
  );
}
