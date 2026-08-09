"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useMultiplayerSession } from "@/app/hooks/useMultiplayerSession";
import { isMobileViewport } from "@/app/hooks/isMobileViewport";
import { useDefaultCollapsed } from "@/app/hooks/useDefaultCollapsed";
import { BoardGrid } from "@/app/components/Board";
import { GameStatusPanel } from "@/app/components/GameStatusPanel";
import { EndScreen } from "@/app/components/EndScreen";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { CardCatalog } from "@/app/components/CardCatalog";
import { InstructionsModal } from "@/app/components/InstructionsModal";
import { NewGameModal, NewGameSetup } from "@/app/components/NewGameModal";
import { nameFor, SeatRow } from "@/app/join/[code]/page";
import { CENTER_EFFECTS, randomCenterEffectPool } from "@/lib/content/centerEffects";
import { ResolutionResult, resolveBoard } from "@/lib/engine/resolution";
import { currentPlayerId, isFlipUnlocked } from "@/lib/engine/turns";
import { CenterEffectId, GameState } from "@/lib/engine/types";
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
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => setIsMobile(isMobileViewport()), []);
  const [cardsCollapsed, setCardsCollapsed] = useDefaultCollapsed(isMobile);
  const [rematchSetup, setRematchSetup] = useState<NewGameSetup | null>(null);

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <header className="flex w-full max-w-4xl flex-col gap-2">
        <div className="flex w-full items-center justify-between gap-2">
          <h1 className="text-lg font-semibold sm:text-xl">
            Board Game{" "}
            <span className="font-normal text-zinc-500">
              — {session.lobby ? CENTER_EFFECTS[session.lobby.centerEffect].label : `room ${roomCode}`}
            </span>
          </h1>
          <ThemeToggle />
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5">
          <Link
            href="/"
            className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            ◀ Home
          </Link>
          {!session.roomClosed && session.connected && session.lobby?.started && session.gameState && (
            <button
              onClick={() => setCardsCollapsed(!cardsCollapsed)}
              className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {cardsCollapsed ? "▶" : "◀"} Cards
            </button>
          )}
          <button
            onClick={() => setShowInstructions(true)}
            className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            How to play
          </button>
          {!session.roomClosed && session.connected && !session.needsName && (
            <button
              onClick={() => setConfirmingEnd(true)}
              className="rounded-full border border-red-300 px-2.5 py-1 text-xs whitespace-nowrap text-red-600 hover:bg-red-50 sm:px-4 sm:py-1.5 sm:text-sm dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              End room
            </button>
          )}
        </div>
      </header>

      {showInstructions && <InstructionsModal onClose={() => setShowInstructions(false)} />}

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

      {session.roomClosed && (
        <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-lg border border-zinc-300 p-5 text-center dark:border-zinc-700">
          <p className="text-sm font-medium">This room has been closed.</p>
          <Link href="/" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black">
            Back to home
          </Link>
        </div>
      )}

      {!session.roomClosed && !session.connected && <p className="text-sm text-zinc-500">Connecting to the game server…</p>}

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

      {!session.roomClosed && session.connected && !session.needsName && session.lobby?.started && session.gameState && (
        <DisplayGameView
          state={session.gameState}
          lobby={session.lobby}
          rematch={session.rematch}
          rematchSetup={rematchSetup}
          setRematchSetup={setRematchSetup}
          cardsCollapsed={cardsCollapsed}
          onCardsCollapsedChange={setCardsCollapsed}
        />
      )}
    </div>
  );
}

function DisplayLobby({ roomCode, session }: { roomCode: string; session: ReturnType<typeof useMultiplayerSession> }) {
  const { lobby, error, startGame } = session;
  const [copied, setCopied] = useState(false);
  const joinUrl = lobby ? `${lobby.serverOrigin}/join/${roomCode}` : "";

  return (
    <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-zinc-300 p-5 dark:border-zinc-700">
      <div>
        <p className="mb-1 text-sm font-medium">Everyone joins from their own phone:</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900">
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
  rematchSetup,
  setRematchSetup,
  cardsCollapsed,
  onCardsCollapsedChange,
}: {
  state: GameState;
  lobby: LobbyState;
  rematch: (centerEffect: CenterEffectId) => void;
  rematchSetup: NewGameSetup | null;
  setRematchSetup: (setup: NewGameSetup | null) => void;
  cardsCollapsed: boolean;
  onCardsCollapsedChange: (collapsed: boolean) => void;
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
        currentCenterEffect={state.config.centerEffect}
        collapsed={cardsCollapsed}
        onCollapsedChange={onCardsCollapsedChange}
      />

      <div className="flex min-w-0 flex-1 flex-col items-center gap-6">
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
          highlightedCardId={null}
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
              <button
                onClick={() => setRematchSetup({ playerCount: lobby.playerCount, centerEffect: "random" })}
                className="shrink-0 rounded-full bg-zinc-900 px-4 py-1.5 text-sm whitespace-nowrap text-white dark:bg-zinc-100 dark:text-black"
              >
                Play again (same room)
              </button>
            }
          />
        )}

        {rematchSetup && (
          <NewGameModal
            title="Play again"
            setup={rematchSetup}
            onChange={setRematchSetup}
            onCancel={() => setRematchSetup(null)}
            onConfirm={() => {
              const pool = randomCenterEffectPool(rematchSetup.playerCount);
              const centerEffect = rematchSetup.centerEffect === "random" ? pool[Math.floor(Math.random() * pool.length)] : rematchSetup.centerEffect;
              rematch(centerEffect);
              setRematchSetup(null);
            }}
            confirmLabel="Start"
            showPlayerCount={false}
          />
        )}
      </div>

      <GameStatusPanel
        state={state}
        viewerId={DISPLAY_VIEWER_ID}
        nameFor={(id) => nameFor(lobby, id)}
        flipUnlocked={flipUnlocked}
        isMyTurn={false}
        myMustPass={false}
      />
    </div>
  );
}
