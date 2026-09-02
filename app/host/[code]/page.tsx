"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useMultiplayerSession } from "@/app/hooks/useMultiplayerSession";
import { loadCredentials } from "@/app/hooks/multiplayerCredentials";
import { MultiplayerUnavailableBanner } from "@/app/components/MultiplayerUnavailableNotice";
import { isMobileViewport } from "@/app/hooks/isMobileViewport";
import { useDefaultCollapsed } from "@/app/hooks/useDefaultCollapsed";
import { BoardGrid } from "@/app/components/Board";
import { GameStatusPanel } from "@/app/components/GameStatusPanel";
import { EndScreen } from "@/app/components/EndScreen";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { HomeIcon } from "@/app/components/HomeIcon";
import { CardCatalog } from "@/app/components/CardCatalog";
import { LocationCatalog } from "@/app/components/LocationCatalog";
import { InstructionsModal } from "@/app/components/InstructionsModal";
import { LocationTitle } from "@/app/components/LocationTitle";
import { NewGameModal, NewGameSetup } from "@/app/components/NewGameModal";
import { RoomStatsModal } from "@/app/components/RoomStatsModal";
import { nameFor, SeatRow } from "@/app/join/[code]/page";
import { CENTER_EFFECTS, randomCenterEffectPool } from "@/lib/content/centerEffects";
import { ResolutionResult, resolveBoard } from "@/lib/engine/resolution";
import { currentPlayerId, isFlipUnlocked } from "@/lib/engine/turns";
import { AiDifficulty, CenterEffectId, GameState } from "@/lib/engine/types";
import { DISPLAY_VIEWER_ID, LobbyState } from "@/lib/server/protocol";

/** BoardGrid/legalCellKeys and flipTargetIds are always empty here -- the display never places or flips cards, only shows the board. */
const EMPTY_KEYS = new Set<string>();

/**
 * Jackbox-style shared screen -- this device holds no seat, just displays a fully
 * redacted (nobody's) board and runs the room's admin controls, while every real
 * player joins from their own phone at /join/[code]. Only reachable with the host
 * credentials createMultiplayerRoom's asDisplay flow saves right before routing here
 * (see app/page.tsx's startDisplayRoom) -- a browser with no stored credentials for
 * this room was never the one that created it, so there's nothing for it to reconnect
 * to as a display.
 */
export default function HostPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-500">Loading…</div>;
  }
  return <Display />;
}

function Display() {
  const params = useParams<{ code: string }>();
  const roomCode = (Array.isArray(params.code) ? params.code[0] : params.code || "").toUpperCase();
  const session = useMultiplayerSession(roomCode);
  const [showInstructions, setShowInstructions] = useState(false);
  const [showRoomStats, setShowRoomStats] = useState(false);
  const [newGameSetup, setNewGameSetup] = useState<NewGameSetup | null>(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => setIsMobile(isMobileViewport()), []);
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

  const showGame = !session.roomClosed && session.connected && session.lobby?.started && session.gameState;
  const gameEnded = session.gameState?.phase === "ended";

  const header = (
    <header className="flex w-full max-w-4xl flex-col gap-2">
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
        <Link
          href="/"
          className="justify-self-start flex items-center gap-1 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          <HomeIcon />
          Home
        </Link>
        <div className="justify-self-center text-center">
          <LocationTitle def={session.lobby ? CENTER_EFFECTS[session.lobby.centerEffect] : null} fallback={`Room ${roomCode}`} />
        </div>
        <div className="justify-self-end">
          <ThemeToggle />
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center justify-between gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {showGame && (
            <button
              onClick={openCards}
              className="rounded-full border border-zinc-300 px-2.5 py-0 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-0.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {cardsCollapsed ? "▶" : "◀"} Cards
            </button>
          )}
          {showGame && (
            <button
              onClick={openLocations}
              className="rounded-full border border-zinc-300 px-2.5 py-0 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-0.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {locationsCollapsed ? "▶" : "◀"} <span className="sm:hidden">Loc.</span>
              <span className="hidden sm:inline">Locations</span>
            </button>
          )}
          <button
            onClick={() => setShowInstructions(true)}
            className="rounded-full border border-zinc-300 px-2.5 py-0 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-0.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Rules
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {session.lobby && (
            <button
              onClick={() => setShowRoomStats(true)}
              className="rounded-full border border-zinc-300 px-2.5 py-0 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-0.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Stats
            </button>
          )}
          {showGame && session.lobby && session.gameState && (
            <button
              onClick={() =>
                setNewGameSetup({ playerCount: session.lobby!.playerCount, centerEffect: "random", aiDifficulty: session.gameState!.config.aiDifficulty })
              }
              title={gameEnded ? undefined : "Starting a new game abandons the current one for everyone in this room."}
              className="rounded-full border border-zinc-300 px-2.5 py-0 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-0.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              New Game
            </button>
          )}
          {!session.roomClosed && session.connected && !session.needsName && (
            <button
              onClick={() => setConfirmingEnd(true)}
              className="rounded-full border border-red-300 px-2.5 py-0 text-xs whitespace-nowrap text-red-600 hover:bg-red-50 sm:px-4 sm:py-0.5 sm:text-sm dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              End room
            </button>
          )}
        </div>
      </div>
    </header>
  );

  const popups = (
    <>
      {showInstructions && <InstructionsModal onClose={() => setShowInstructions(false)} />}
      {showRoomStats && session.lobby && <RoomStatsModal lobby={session.lobby} onClose={() => setShowRoomStats(false)} />}
      {newGameSetup && session.gameState && (
        <NewGameModal
          title="New game"
          setup={newGameSetup}
          onChange={setNewGameSetup}
          onCancel={() => setNewGameSetup(null)}
          onConfirm={() => {
            const pool = randomCenterEffectPool(newGameSetup.playerCount);
            const centerEffect = newGameSetup.centerEffect === "random" ? pool[Math.floor(Math.random() * pool.length)] : newGameSetup.centerEffect;
            session.rematch(centerEffect, newGameSetup.aiDifficulty, newGameSetup.centerEffect);
            setNewGameSetup(null);
          }}
          confirmLabel="Start"
          showPlayerCount={false}
        />
      )}

      {confirmingEnd && (
        <div className="fixed top-20 left-1/2 z-50 w-[min(90vw,20rem)] -translate-x-1/2 rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <p className="mb-2 font-medium">End this room?</p>
          <p className="mb-2 text-xs text-zinc-500">
            This closes it for everyone right now, mid-game or not, and can&rsquo;t be undone. The join link stops working.
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setConfirmingEnd(false)}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                session.endRoom();
                setConfirmingEnd(false);
              }}
              className="rounded-full bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
            >
              End room
            </button>
          </div>
        </div>
      )}
    </>
  );

  // See join/[code]/page.tsx's Room() for why this is split into two return paths
  // instead of always rendering the same wrapper -- only the active game view has a
  // CardCatalog/GameStatusPanel row for the header to share the top edge with.
  if (showGame && session.gameState && session.lobby) {
    return (
      <div className="flex flex-1 flex-col items-center px-4 py-8">
        {popups}
        <DisplayGameView
          header={header}
          state={session.gameState}
          lobby={session.lobby}
          rematch={session.rematch}
          cardsCollapsed={cardsCollapsed}
          onCardsCollapsedChange={(next) => {
            setCardsCollapsed(next);
            if (!next) setLocationsCollapsed(true);
          }}
          locationsCollapsed={locationsCollapsed}
          onLocationsCollapsedChange={(next) => {
            setLocationsCollapsed(next);
            if (!next) setCardsCollapsed(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      {header}
      {popups}

      {session.roomClosed && (
        <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-lg border border-zinc-300 p-5 text-center dark:border-zinc-700">
          <p className="text-sm font-medium">This room has been closed.</p>
          <Link href="/" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black">
            Back to home
          </Link>
        </div>
      )}

      {!session.roomClosed && !session.connected && session.connectFailed && <MultiplayerUnavailableBanner />}

      {!session.roomClosed && !session.connected && !session.connectFailed && (
        <p className="text-sm text-zinc-500">Connecting to the game server…</p>
      )}

      {!session.roomClosed && session.connected && session.needsName && (
        <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-lg border border-zinc-300 p-5 text-center dark:border-zinc-700">
          <p className="text-sm font-medium">This screen isn&rsquo;t connected to room {roomCode}.</p>
          <p className="text-xs text-zinc-500">Only the device that opened this display can reconnect to it -- create a new one from the home screen.</p>
          <Link href="/" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black">
            Back to home
          </Link>
        </div>
      )}

      {!session.roomClosed && session.connected && !session.needsName && !session.lobby?.started && (
        <DisplayLobby roomCode={roomCode} session={session} />
      )}
    </div>
  );
}

function DisplayLobby({ roomCode, session }: { roomCode: string; session: ReturnType<typeof useMultiplayerSession> }) {
  const { lobby, error, startGame } = session;
  const [copied, setCopied] = useState(false);
  const joinUrl = lobby ? `${lobby.serverOrigin}/join/${roomCode}` : "";
  // This page is only ever reachable with the host's own stored credentials (see this
  // file's top-level doc comment), so unlike join/[code]/page.tsx's Lobby there's no
  // separate isHost check needed here -- whoever's looking at this screen is the host.
  const roomPassword = loadCredentials(roomCode)?.roomPassword;

  return (
    <div className="flex w-full max-w-xl flex-col gap-4 rounded-lg border border-zinc-300 p-5 dark:border-zinc-700">
      <div>
        <p className="mb-1 text-sm font-medium">Everyone joins from their own phone:</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-xs whitespace-nowrap dark:border-zinc-700 dark:bg-zinc-900">
            {joinUrl}
          </code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(joinUrl).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="shrink-0 rounded-full border border-zinc-300 px-3 py-1.5 text-xs whitespace-nowrap hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Or join with just the room code:{" "}
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-sm font-semibold tracking-wide text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
            {roomCode}
          </span>
        </p>
        {roomPassword && (
          <p className="mt-1 text-xs text-zinc-500">
            Room password: <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{roomPassword}</span>
          </p>
        )}
        <p className="mt-1 text-xs text-zinc-500">
          Everyone must be on the same network as this screen. Any empty seats left when you hit Start get filled with AI.
        </p>
      </div>

      <div>
        <p className="mb-1 text-sm font-medium">
          Players ({lobby?.seats.length ?? 0} / {lobby?.playerCount ?? "?"})
        </p>
        <ul className="flex flex-col gap-1">
          {lobby?.seats.map((seat) => <SeatRow key={seat.playerId} seat={seat} isHost={false} isYou={false} />)}
          {lobby &&
            Array.from({ length: Math.max(0, lobby.playerCount - lobby.seats.length) }).map((_, i) => (
              <li key={`open-${i}`} className="rounded border border-dashed border-zinc-300 px-2 py-1 text-xs text-zinc-400 dark:border-zinc-700">
                Open seat — AI if unfilled at Start
              </li>
            ))}
        </ul>
      </div>

      {lobby && (
        <p className="text-xs text-zinc-500">
          Location: <span className="font-medium text-zinc-700 dark:text-zinc-300">{CENTER_EFFECTS[lobby.centerEffect].label}</span>
        </p>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <button onClick={startGame} className="rounded-full bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-black">
        Start game
      </button>
    </div>
  );
}

function DisplayGameView({
  state,
  lobby,
  rematch,
  cardsCollapsed,
  onCardsCollapsedChange,
  locationsCollapsed,
  onLocationsCollapsedChange,
  header,
}: {
  /** Rendered as the first child of the middle column -- see join/[code]/page.tsx's
   * GameView, same reasoning: shares CardCatalog/GameStatusPanel's row so they span
   * the full height alongside the header, not just alongside the board underneath it. */
  header: React.ReactNode;
  state: GameState;
  lobby: LobbyState;
  rematch: (centerEffect: CenterEffectId, aiDifficulty: AiDifficulty, centerEffectMode?: CenterEffectId | "random") => void;
  cardsCollapsed: boolean;
  onCardsCollapsedChange: (collapsed: boolean) => void;
  locationsCollapsed: boolean;
  onLocationsCollapsedChange: (collapsed: boolean) => void;
}) {
  const endResult: ResolutionResult | null =
    state.phase === "ended"
      ? resolveBoard(state.board, state.config.boardBounds, state.round, state.config.centerEffect, state.players.map((p) => p.id))
      : null;
  const resolvedCards = endResult ? new Map(endResult.cards.map((c) => [c.instanceId, c])) : undefined;

  const opponentVisibleBoardCardIds = new Set([...state.board.values()].filter((c) => c.faceUp).map((c) => c.cardId));
  const flipUnlocked = isFlipUnlocked(state.round, state.config);

  return (
    <div className="flex w-full flex-1 flex-col gap-6 lg:flex-row lg:items-start lg:justify-center">
      <CardCatalog
        playerCount={lobby.playerCount}
        opponentVisibleBoardCardIds={opponentVisibleBoardCardIds}
        collapsed={cardsCollapsed}
        onCollapsedChange={onCardsCollapsedChange}
      />
      <LocationCatalog
        playerCount={lobby.playerCount}
        currentCenterEffect={state.config.centerEffect}
        collapsed={locationsCollapsed}
        onCollapsedChange={onLocationsCollapsedChange}
      />

      <div className="flex min-w-0 flex-1 flex-col items-center gap-6">
        {header}
        <p className="min-h-[1.25rem] text-sm">
          {state.phase === "playing" && `${nameFor(lobby, currentPlayerId(state))} is playing…`}
          {state.phase === "voting" && "Tallying votes…"}
        </p>

        <BoardGrid
          state={state}
          viewerId={DISPLAY_VIEWER_ID}
          nameFor={(id) => nameFor(lobby, id)}
          legalCellKeys={EMPTY_KEYS}
          flipTargetIds={EMPTY_KEYS}
          selectedInstanceId={null}
          dragOverKey={null}
          revealAll={state.phase === "ended"}
          resolvedCards={resolvedCards}
          onCellClick={() => {}}
          onCellDragOver={() => {}}
          onCellDragLeave={() => {}}
          onCellDrop={() => {}}
        />

        {state.phase === "ended" && endResult && (
          <EndScreen
            state={state}
            result={endResult}
            viewerId={DISPLAY_VIEWER_ID}
            nameFor={(id) => nameFor(lobby, id)}
            footer={
              lobby.seats.every((s) => s.isAI) ? (
                // No real seats at all (every seat auto-filled with AI at Start) --
                // there's genuinely nobody who could ever click "ready" on their own
                // phone, so the readiness gate would wait forever. The display is the
                // only device in the room at all here, so it gets to continue directly.
                <button
                  onClick={() => {
                    const mode = lobby.centerEffectMode;
                    const centerEffect =
                      mode === "random"
                        ? (() => {
                            const pool = randomCenterEffectPool(lobby.playerCount);
                            return pool[Math.floor(Math.random() * pool.length)];
                          })()
                        : mode;
                    rematch(centerEffect, state.config.aiDifficulty, mode);
                  }}
                  className="shrink-0 rounded-full bg-zinc-900 px-4 py-1.5 text-sm whitespace-nowrap text-white dark:bg-zinc-100 dark:text-black"
                >
                  Continue
                </button>
              ) : (
                // The display holds no seat of its own (see DISPLAY_VIEWER_ID) -- it
                // can't "ready up" itself, so this is a passive live status instead of
                // a button, mirroring join/[code]/page.tsx's RematchReadyButton count.
                // Every real seated player has to click ready on their own phone (see
                // GameSession.readyForRematch); the moderator-override "New Game"
                // button in the header above still starts a fresh game immediately
                // regardless.
                <p className="shrink-0 text-sm whitespace-nowrap text-zinc-500">
                  Waiting on players ({lobby.rematchReadyPlayerIds.length}/{lobby.seats.filter((s) => !s.isAI).length} ready)
                </p>
              )
            }
          />
        )}
      </div>

      <GameStatusPanel
        state={state}
        viewerId={DISPLAY_VIEWER_ID}
        nameFor={(id) => nameFor(lobby, id)}
        flipUnlocked={flipUnlocked}
      />
    </div>
  );
}
