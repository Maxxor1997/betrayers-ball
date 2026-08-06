"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useMultiplayerSession } from "@/app/hooks/useMultiplayerSession";
import { isMobileViewport } from "@/app/hooks/isMobileViewport";
import { useDefaultCollapsed } from "@/app/hooks/useDefaultCollapsed";
import { BoardGrid } from "@/app/components/Board";
import { Hand } from "@/app/components/Hand";
import { GameStatusPanel } from "@/app/components/GameStatusPanel";
import { EndScreen } from "@/app/components/EndScreen";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { CardCatalog } from "@/app/components/CardCatalog";
import { InstructionsModal } from "@/app/components/InstructionsModal";
import { NewGameModal, NewGameSetup } from "@/app/components/NewGameModal";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, randomCenterEffectPool } from "@/lib/content/centerEffects";
import { ResolutionResult, resolveBoard } from "@/lib/engine/resolution";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, isFlipUnlocked, mustPass } from "@/lib/engine/turns";
import { CardId, CenterEffectId, GameAction, GameState, Position, posKey } from "@/lib/engine/types";
import { LobbyState, SeatInfo } from "@/lib/server/protocol";

const DRAG_MIME = "application/x-card-instance-id";

function nameFor(lobby: LobbyState | null, playerId: string): string {
  return lobby?.seats.find((s) => s.playerId === playerId)?.name ?? playerId;
}

/**
 * Mount-gated the same way /play is (see PlayPage there) -- avoids any server/client
 * markup mismatch, since sessionStorage/window.location are only meaningful client-side.
 */
export default function JoinPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-500">Loading…</div>;
  }
  return <Room />;
}

function Room() {
  const params = useParams<{ code: string }>();
  const roomCode = (Array.isArray(params.code) ? params.code[0] : params.code || "").toUpperCase();
  const session = useMultiplayerSession(roomCode);
  const [showInstructions, setShowInstructions] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => setIsMobile(isMobileViewport()), []);
  const [cardsCollapsed, setCardsCollapsed] = useDefaultCollapsed(isMobile);

  const isHost = !!session.lobby && session.myPlayerId === session.lobby.hostPlayerId;

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <header className="flex w-full max-w-4xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-start">
          <h1 className="text-lg font-semibold sm:text-xl">
            Board Game <span className="font-normal text-zinc-500">— room {roomCode}</span>
          </h1>
          <span className="sm:hidden">
            <ThemeToggle />
          </span>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:gap-3">
          <span className="hidden sm:inline-flex">
            <ThemeToggle />
          </span>
          <Link
            href="/"
            className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            ◀ Home
          </Link>
          {!session.roomClosed && session.connected && !session.needsName && session.lobby?.started && session.gameState && (
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
          {!session.roomClosed && isHost && (
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
          <p className="text-sm font-medium">This room has been closed by the host.</p>
          <Link href="/" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black">
            Back to home
          </Link>
        </div>
      )}

      {!session.roomClosed && !session.connected && <p className="text-sm text-zinc-500">Connecting to the game server…</p>}

      {!session.roomClosed && session.connected && session.needsName && <NameEntry onJoin={session.join} error={session.error} />}

      {!session.roomClosed && session.connected && !session.needsName && !session.lobby?.started && (
        <Lobby roomCode={roomCode} session={session} />
      )}

      {!session.roomClosed && session.connected && !session.needsName && session.lobby?.started && session.gameState && session.myPlayerId && (
        <GameView
          state={session.gameState}
          lobby={session.lobby}
          myPlayerId={session.myPlayerId}
          dispatch={session.dispatch}
          rematch={session.rematch}
          cardsCollapsed={cardsCollapsed}
          onCardsCollapsedChange={setCardsCollapsed}
        />
      )}
    </div>
  );
}

function NameEntry({ onJoin, error }: { onJoin: (name: string) => void; error: string | null }) {
  const [name, setName] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onJoin(name.trim() || "Player");
      }}
      className="flex w-full max-w-xs flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700"
    >
      <p className="text-sm font-medium">Join this game</p>
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name"
        maxLength={24}
        className="rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
      />
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button type="submit" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black">
        Join
      </button>
    </form>
  );
}

function Lobby({ roomCode, session }: { roomCode: string; session: ReturnType<typeof useMultiplayerSession> }) {
  const { lobby, myPlayerId, error, startGame } = session;
  const [copied, setCopied] = useState(false);
  // The server's own LAN-reachable origin (see lib/server/network.ts's getLanOrigin),
  // not window.location.origin -- the host almost always loaded this via "localhost",
  // which is meaningless to share with a different device.
  const joinUrl = lobby ? `${lobby.serverOrigin}/join/${roomCode}` : "";
  const isHost = !!lobby && myPlayerId === lobby.hostPlayerId;

  return (
    <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-zinc-300 p-5 dark:border-zinc-700">
      <div>
        <p className="mb-1 text-sm font-medium">Share this link with the other players:</p>
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
          Everyone must be on the same network as the host. Any empty seats left when you hit Start get filled with AI.
        </p>
      </div>

      <div>
        <p className="mb-1 text-sm font-medium">
          Players ({lobby?.seats.length ?? 0} / {lobby?.playerCount ?? "?"})
        </p>
        <ul className="flex flex-col gap-1">
          {lobby?.seats.map((seat) => (
            <SeatRow key={seat.playerId} seat={seat} isHost={seat.playerId === lobby.hostPlayerId} isYou={seat.playerId === myPlayerId} />
          ))}
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

      {isHost ? (
        <button onClick={startGame} className="rounded-full bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-black">
          Start game
        </button>
      ) : (
        <p className="text-sm text-zinc-500">Waiting for the host to start…</p>
      )}
    </div>
  );
}

function SeatRow({ seat, isHost, isYou }: { seat: SeatInfo; isHost: boolean; isYou: boolean }) {
  return (
    <li
      className={`flex items-center justify-between gap-2 rounded border px-2 py-1 text-sm ${
        seat.connected || seat.isAI ? "border-zinc-300 dark:border-zinc-700" : "border-zinc-200 opacity-50 dark:border-zinc-800"
      }`}
    >
      <span>
        {seat.name}
        {isYou && <span className="text-zinc-500"> (you)</span>}
        {isHost && <span className="text-zinc-500"> · host</span>}
      </span>
      <span className="text-[10px] tracking-wide text-zinc-400 uppercase">
        {seat.isAI ? "AI" : seat.connected ? "connected" : "disconnected"}
      </span>
    </li>
  );
}

function GameView({
  state,
  lobby,
  myPlayerId,
  dispatch,
  rematch,
  cardsCollapsed,
  onCardsCollapsedChange,
}: {
  state: GameState;
  lobby: LobbyState;
  myPlayerId: string;
  dispatch: (action: GameAction) => void;
  rematch: (centerEffect: CenterEffectId) => void;
  cardsCollapsed: boolean;
  onCardsCollapsedChange: (collapsed: boolean) => void;
}) {
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [pendingFlip, setPendingFlip] = useState<{ instanceId: string; label: string } | null>(null);
  const [highlightedCardId, setHighlightedCardId] = useState<CardId | null>(null);
  // Rematch's own location picker -- player count isn't reconfigurable (fixed to the
  // room's existing seats), so this only ever asks for a center effect.
  const [rematchSetup, setRematchSetup] = useState<NewGameSetup | null>(null);

  // Rematch deals a fresh game into the same room/component tree (no navigation, no
  // remount) -- once the phase flips back from "ended" to "playing", any selection
  // left over from the previous game is stale (e.g. a pendingFlip instanceId that no
  // longer exists in the new deal) and needs clearing.
  const prevPhaseRef = useRef(state.phase);
  useEffect(() => {
    if (prevPhaseRef.current === "ended" && state.phase !== "ended") {
      setSelectedInstanceId(null);
      setDragOverKey(null);
      setPendingFlip(null);
      setHighlightedCardId(null);
    }
    prevPhaseRef.current = state.phase;
  }, [state.phase]);

  const isMyTurn = state.phase === "playing" && currentPlayerId(state) === myPlayerId;
  const isVoting = state.phase === "voting";
  const myVotePending = isVoting && !(myPlayerId in state.votes);

  const legalCells = getLegalPlacementCells(state);
  const legalCellKeys = new Set(legalCells.map(posKey));
  const flipTargetIds = new Set((isMyTurn ? getLegalFlipTargets(state) : []).map((c) => c.instanceId));
  const flipUnlocked = isFlipUnlocked(state.round, state.config);
  const myMustPass = isMyTurn && mustPass(state);

  const me = state.players.find((p) => p.id === myPlayerId)!;

  // Computed once here (not inside EndScreen) so BoardGrid can also show each card's
  // scoring breakdown on hover, not just the end-of-game summary table -- same
  // approach single-player's Game() uses. Safe against the true (unredacted) board
  // now that the game has ended -- see redactedStateFor's doc comment on why the
  // server stops redacting the board at that point.
  const endResult: ResolutionResult | null =
    state.phase === "ended"
      ? resolveBoard(state.board, state.config.boardBounds, state.round, state.config.centerEffect, state.players.map((p) => p.id))
      : null;
  const resolvedCards = endResult ? new Map(endResult.cards.map((c) => [c.instanceId, c])) : undefined;

  function placeCard(instanceId: string, pos: Position) {
    if (!legalCellKeys.has(posKey(pos))) return;
    dispatch({ type: "place", playerId: myPlayerId, instanceId, position: pos });
    setSelectedInstanceId(null);
  }

  function handleHandCardClick(instanceId: string) {
    if (!isMyTurn) return;
    setSelectedInstanceId((prev) => (prev === instanceId ? null : instanceId));
  }

  function handleBoardCellClick(pos: Position) {
    if (!isMyTurn) return;
    const key = posKey(pos);
    const occupant = state.board.get(key);

    if (occupant) {
      if (!selectedInstanceId && !occupant.faceUp && flipTargetIds.has(occupant.instanceId)) {
        const label =
          occupant.ownerId === myPlayerId
            ? `your ${CARD_DEFS[occupant.cardId].name} (${CARD_DEFS[occupant.cardId].base})`
            : `${nameFor(lobby, occupant.ownerId)}'s face-down card`;
        setPendingFlip({ instanceId: occupant.instanceId, label });
      }
      return;
    }

    if (selectedInstanceId) placeCard(selectedInstanceId, pos);
  }

  function handleHandDragStart(e: React.DragEvent, instanceId: string) {
    if (!isMyTurn) return;
    e.dataTransfer.setData(DRAG_MIME, instanceId);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleCellDragOver(e: React.DragEvent, key: string) {
    if (!isMyTurn || !legalCellKeys.has(key)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverKey(key);
  }

  function handleCellDrop(e: React.DragEvent, pos: Position) {
    e.preventDefault();
    setDragOverKey(null);
    if (!isMyTurn) return;
    const instanceId = e.dataTransfer.getData(DRAG_MIME);
    if (instanceId) placeCard(instanceId, pos);
  }

  function handlePass() {
    if (!isMyTurn) return;
    dispatch({ type: "pass", playerId: myPlayerId });
  }

  function handleCastVote(vote: boolean) {
    dispatch({ type: "castVote", playerId: myPlayerId, vote });
  }

  function confirmFlip() {
    if (!pendingFlip) return;
    dispatch({ type: "flip", playerId: myPlayerId, instanceId: pendingFlip.instanceId });
    setPendingFlip(null);
  }

  const myCardIds = new Set([
    ...me.hand.map((c) => c.cardId),
    ...[...state.board.values()].filter((c) => c.ownerId === myPlayerId).map((c) => c.cardId),
  ]);
  const opponentVisibleBoardCardIds = new Set(
    [...state.board.values()].filter((c) => c.faceUp && c.ownerId !== myPlayerId).map((c) => c.cardId)
  );

  const isHost = myPlayerId === lobby.hostPlayerId;

  return (
    <div className="flex w-full flex-1 flex-col gap-6 lg:flex-row lg:items-start lg:justify-center">
      <CardCatalog
        playerCount={lobby.playerCount}
        myCardIds={myCardIds}
        opponentVisibleBoardCardIds={opponentVisibleBoardCardIds}
        currentCenterEffect={state.config.centerEffect}
        collapsed={cardsCollapsed}
        onCollapsedChange={onCardsCollapsedChange}
      />

      <div className="flex min-w-0 flex-1 flex-col items-center gap-6">
        <p className="min-h-[1.25rem] text-sm">
          {state.phase === "playing"
            ? isMyTurn
              ? selectedInstanceId
                ? "Tap a highlighted cell to place the selected card (or just drag it there)."
                : flipUnlocked && !state.hasFlippedThisTurn
                  ? "You can optionally flip a face-down card face-up first, then drag a card from your hand onto a highlighted cell to place it."
                  : "Drag a card from your hand onto a highlighted cell to place it."
              : `${nameFor(lobby, currentPlayerId(state))} is playing…`
            : isVoting && !myVotePending && "Tallying votes…"}
        </p>

        <BoardGrid
          state={state}
          viewerId={myPlayerId}
          nameFor={(id) => nameFor(lobby, id)}
          legalCellKeys={legalCellKeys}
          flipTargetIds={flipTargetIds}
          selectedInstanceId={selectedInstanceId}
          dragOverKey={dragOverKey}
          revealAll={state.phase === "ended"}
          resolvedCards={resolvedCards}
          highlightedCardId={highlightedCardId}
          onCellClick={handleBoardCellClick}
          onCellDragOver={handleCellDragOver}
          onCellDragLeave={() => setDragOverKey(null)}
          onCellDrop={handleCellDrop}
        />

        {state.phase === "ended" && endResult && (
          <EndScreen
            state={state}
            result={endResult}
            viewerId={myPlayerId}
            nameFor={(id) => nameFor(lobby, id)}
            footer={
              isHost ? (
                <button
                  onClick={() => setRematchSetup({ playerCount: lobby.playerCount, centerEffect: "random" })}
                  className="self-start rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black"
                >
                  Play again (same room)
                </button>
              ) : (
                <p className="text-sm text-zinc-500">Waiting for the host to start a new game…</p>
              )
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

        {(state.phase === "playing" || state.phase === "voting") && (
          <div className="flex w-full flex-col items-center gap-3">
            <Hand
              cards={me.hand}
              selectedInstanceId={selectedInstanceId}
              onCardClick={handleHandCardClick}
              onCardDragStart={handleHandDragStart}
              onHoverCardId={setHighlightedCardId}
              disabled={!isMyTurn}
            />
            {myMustPass && (
              <button onClick={handlePass} className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black">
                No legal move — Pass
              </button>
            )}
          </div>
        )}

        {myVotePending && (
          <div className="fixed top-20 left-1/2 z-50 w-[min(90vw,20rem)] -translate-x-1/2 rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            <p className="mb-2 font-medium">Vote: end the game now?</p>
            <p className="mb-2 text-xs text-zinc-500">
              Round {state.round} of {state.config.roundCap}. Everyone votes privately; a majority is needed to end (ties continue).
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => handleCastVote(false)}
                className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Keep playing
              </button>
              <button
                onClick={() => handleCastVote(true)}
                className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black"
              >
                End game
              </button>
            </div>
          </div>
        )}

        {pendingFlip && (
          <div className="fixed top-20 left-1/2 z-50 w-[min(90vw,20rem)] -translate-x-1/2 rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            <p className="mb-2">Flip {pendingFlip.label} face-up? This is permanent and uses your one flip for the turn.</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingFlip(null)}
                className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button onClick={confirmFlip} className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black">
                Flip
              </button>
            </div>
          </div>
        )}
      </div>

      <GameStatusPanel
        state={state}
        viewerId={myPlayerId}
        nameFor={(id) => nameFor(lobby, id)}
        flipUnlocked={flipUnlocked}
        isMyTurn={isMyTurn}
        myMustPass={myMustPass}
      />
    </div>
  );
}
