"use client";

import { useEffect, useState } from "react";
import { CARD_DEFS } from "@/lib/engine/cards";
import { inBounds, isCenterPosition } from "@/lib/engine/board";
import { applyAction, canRequestEnd, createGame, DEFAULT_2P_CONFIG } from "@/lib/engine/game";
import { resolveBoard, ResolvedCard } from "@/lib/engine/resolution";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, mustPass } from "@/lib/engine/turns";
import { CardInstance, GameAction, GameState, Position, posKey } from "@/lib/engine/types";
import { chooseAiAction } from "@/lib/ai/randomAi";

const HUMAN = "human";
const AI = "ai";

const OWNER_STYLES: Record<string, string> = {
  [HUMAN]: "border-blue-500 bg-blue-50 dark:bg-blue-950",
  [AI]: "border-red-500 bg-red-50 dark:bg-red-950",
};

const DRAG_MIME = "application/x-card-instance-id";

function newGameState(): GameState {
  return createGame([HUMAN, AI], DEFAULT_2P_CONFIG);
}

// Game state includes a random shuffle, so it must never be created during SSR
// (server and client would shuffle differently and React would flag a hydration
// mismatch). Rendering nothing until after mount guarantees the first real render
// of <Game/> happens purely on the client.
export default function PlayPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-500">Loading…</div>;
  }

  return <Game />;
}

function Game() {
  const [state, setState] = useState<GameState>(newGameState);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const dispatch = (action: GameAction) => {
    setState((prev) => {
      try {
        return applyAction(prev, action);
      } catch (err) {
        console.error("Illegal action rejected by engine:", err);
        return prev;
      }
    });
  };

  const isHumanTurn = state.phase === "playing" && currentPlayerId(state) === HUMAN;
  const isAiTurn = state.phase === "playing" && currentPlayerId(state) === AI;

  const legalCells = isHumanTurn ? getLegalPlacementCells(state) : [];
  const legalCellKeys = new Set(legalCells.map(posKey));
  const flipTargetIds = new Set((isHumanTurn ? getLegalFlipTargets(state) : []).map((c) => c.instanceId));
  const flipUnlocked = state.round >= state.config.flipUnlockRound;
  const humanMustPass = isHumanTurn && mustPass(state);

  // Drive the AI's turn(s) automatically. A turn can be up to two actions (an
  // optional flip, then a place/pass); this effect re-fires after each one while
  // it's still the AI's turn, so both actions play out with a short pause between.
  useEffect(() => {
    if (!isAiTurn) return;
    const timer = setTimeout(() => {
      const action = chooseAiAction(state, AI);
      dispatch(action);
    }, 550);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, isAiTurn]);

  function requestFlip(instanceId: string) {
    const card = state.board.get([...state.board.entries()].find(([, c]) => c.instanceId === instanceId)?.[0] ?? "");
    const label = card ? `${CARD_DEFS[card.cardId].name} (owned by ${card.ownerId === HUMAN ? "you" : "the AI"})` : "this card";
    const confirmed = window.confirm(`Flip ${label} face-up? This is permanent and uses your one flip for the turn.`);
    if (!confirmed) return;
    dispatch({ type: "flip", playerId: HUMAN, instanceId });
  }

  function placeCard(instanceId: string, pos: Position) {
    if (!legalCellKeys.has(posKey(pos))) return;
    dispatch({ type: "place", playerId: HUMAN, instanceId, position: pos });
    setSelectedInstanceId(null);
  }

  function handleHandCardClick(instanceId: string) {
    if (!isHumanTurn) return;
    setSelectedInstanceId((prev) => (prev === instanceId ? null : instanceId));
  }

  function handleBoardCellClick(pos: Position) {
    if (!isHumanTurn) return;
    const key = posKey(pos);
    const occupant = state.board.get(key);

    if (occupant) {
      if (!selectedInstanceId && !occupant.faceUp && flipTargetIds.has(occupant.instanceId)) {
        requestFlip(occupant.instanceId);
      }
      return;
    }

    if (selectedInstanceId) placeCard(selectedInstanceId, pos);
  }

  function handleHandDragStart(e: React.DragEvent, instanceId: string) {
    if (!isHumanTurn) return;
    e.dataTransfer.setData(DRAG_MIME, instanceId);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleCellDragOver(e: React.DragEvent, key: string) {
    if (!isHumanTurn || !legalCellKeys.has(key)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverKey(key);
  }

  function handleCellDrop(e: React.DragEvent, pos: Position) {
    e.preventDefault();
    setDragOverKey(null);
    if (!isHumanTurn) return;
    const instanceId = e.dataTransfer.getData(DRAG_MIME);
    if (instanceId) placeCard(instanceId, pos);
  }

  function handlePass() {
    if (!isHumanTurn) return;
    dispatch({ type: "pass", playerId: HUMAN });
  }

  function handleRequestEnd() {
    dispatch({ type: "requestEnd", playerId: HUMAN });
  }

  function handleNewGame() {
    setState(newGameState());
    setSelectedInstanceId(null);
  }

  const human = state.players.find((p) => p.id === HUMAN)!;

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <header className="flex w-full max-w-3xl items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Board Game — engine playtest</h1>
          <p className="text-sm text-zinc-500">
            Round {state.round} / {state.config.roundCap} · {flipUnlocked ? "flipping unlocked" : "flipping locks at round " + state.config.flipUnlockRound}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {state.phase === "playing" && (
            <button
              onClick={handleRequestEnd}
              disabled={!canRequestEnd(state)}
              title={!canRequestEnd(state) && !state.endRequested ? `Available from round ${state.config.minRoundFloor}` : undefined}
              className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {state.endRequested ? "Ending after this round…" : "End game"}
            </button>
          )}
          <button
            onClick={handleNewGame}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            New game
          </button>
        </div>
      </header>

      {state.phase === "playing" && (
        <p className="text-sm">
          {isHumanTurn
            ? selectedInstanceId
              ? "Tap a highlighted cell to place the selected card (or just drag it there)."
              : "Your turn — drag a hand card onto a highlighted cell, or tap a face-down card on the board to flip it."
            : "AI is thinking…"}
        </p>
      )}

      <BoardGrid
        state={state}
        legalCellKeys={legalCellKeys}
        flipTargetIds={flipTargetIds}
        selectedInstanceId={selectedInstanceId}
        dragOverKey={dragOverKey}
        onCellClick={handleBoardCellClick}
        onCellDragOver={handleCellDragOver}
        onCellDragLeave={() => setDragOverKey(null)}
        onCellDrop={handleCellDrop}
      />

      {state.phase === "playing" && (
        <div className="flex flex-col items-center gap-3">
          <Hand
            cards={human.hand}
            selectedInstanceId={selectedInstanceId}
            onCardClick={handleHandCardClick}
            onCardDragStart={handleHandDragStart}
            disabled={!isHumanTurn}
          />
          {humanMustPass && (
            <button onClick={handlePass} className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black">
              No legal move — Pass
            </button>
          )}
        </div>
      )}

      {state.phase === "ended" && <EndScreen state={state} />}
    </div>
  );
}

function BoardGrid({
  state,
  legalCellKeys,
  flipTargetIds,
  selectedInstanceId,
  dragOverKey,
  onCellClick,
  onCellDragOver,
  onCellDragLeave,
  onCellDrop,
}: {
  state: GameState;
  legalCellKeys: Set<string>;
  flipTargetIds: Set<string>;
  selectedInstanceId: string | null;
  dragOverKey: string | null;
  onCellClick: (pos: Position) => void;
  onCellDragOver: (e: React.DragEvent, key: string) => void;
  onCellDragLeave: () => void;
  onCellDrop: (e: React.DragEvent, pos: Position) => void;
}) {
  const { width, height } = state.config.boardBounds;
  const rows = Array.from({ length: height }, (_, y) => y);
  const cols = Array.from({ length: width }, (_, x) => x);

  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))` }}>
      {rows.map((y) =>
        cols.map((x) => {
          const pos = { x, y };
          if (!inBounds(pos, state.config.boardBounds)) return null;
          const key = posKey(pos);
          const isCenter = isCenterPosition(pos, state.config.boardBounds);
          const card = state.board.get(key);
          const isLegal = legalCellKeys.has(key);

          if (isCenter) {
            return (
              <div
                key={key}
                className="flex h-20 w-20 items-center justify-center rounded-md border-2 border-dashed border-zinc-400 text-[10px] text-zinc-400"
              >
                center
              </div>
            );
          }

          if (card) {
            const clickable = !card.faceUp && flipTargetIds.has(card.instanceId) && !selectedInstanceId;
            // Own face-down cards get their identity revealed on hover -- you obviously
            // know what you played, this is just a UI convenience, not a state change.
            const ownFaceDownReveal = !card.faceUp && card.ownerId === HUMAN ? `${CARD_DEFS[card.cardId].name} (${CARD_DEFS[card.cardId].base}) — only visible to you` : undefined;
            return (
              <button
                key={key}
                onClick={() => onCellClick(pos)}
                disabled={!clickable}
                title={clickable ? "Tap to flip face-up" : ownFaceDownReveal}
                className={`flex h-20 w-20 flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 text-center ${OWNER_STYLES[card.ownerId] ?? "border-zinc-400"} ${
                  clickable ? "cursor-pointer ring-2 ring-amber-400" : ""
                }`}
              >
                {card.faceUp ? (
                  <>
                    <span className="text-[10px] leading-tight break-words">{CARD_DEFS[card.cardId].name}</span>
                    <span className="text-lg font-bold leading-none">{CARD_DEFS[card.cardId].base}</span>
                  </>
                ) : (
                  <span className="text-xl">🂠</span>
                )}
              </button>
            );
          }

          return (
            <button
              key={key}
              onClick={() => onCellClick(pos)}
              onDragOver={(e) => onCellDragOver(e, key)}
              onDragLeave={onCellDragLeave}
              onDrop={(e) => onCellDrop(e, pos)}
              disabled={!isLegal}
              className={`h-20 w-20 rounded-md border transition-colors ${
                isLegal
                  ? dragOverKey === key
                    ? "border-emerald-600 bg-emerald-200 dark:bg-emerald-800"
                    : "border-emerald-500 bg-emerald-50 dark:bg-emerald-950"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            />
          );
        })
      )}
    </div>
  );
}

function Hand({
  cards,
  selectedInstanceId,
  onCardClick,
  onCardDragStart,
  disabled,
}: {
  cards: CardInstance[];
  selectedInstanceId: string | null;
  onCardClick: (instanceId: string) => void;
  onCardDragStart: (e: React.DragEvent, instanceId: string) => void;
  disabled: boolean;
}) {
  const sortedCards = [...cards].sort((a, b) => CARD_DEFS[a.cardId].name.localeCompare(CARD_DEFS[b.cardId].name));

  return (
    <div className="flex flex-wrap justify-center gap-2">
      {sortedCards.map((card) => {
        const def = CARD_DEFS[card.cardId];
        const selected = card.instanceId === selectedInstanceId;
        return (
          <button
            key={card.instanceId}
            onClick={() => onCardClick(card.instanceId)}
            draggable={!disabled}
            onDragStart={(e) => onCardDragStart(e, card.instanceId)}
            disabled={disabled}
            className={`flex h-20 w-20 flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 text-center ${
              disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"
            } ${selected ? "border-amber-500 bg-amber-50 dark:bg-amber-950" : "border-zinc-300 dark:border-zinc-700"}`}
          >
            <span className="text-[10px] leading-tight break-words">{def.name}</span>
            <span className="text-lg font-bold leading-none">{def.base}</span>
          </button>
        );
      })}
    </div>
  );
}

function PlayerTable({ label, cards }: { label: string; cards: ResolvedCard[] }) {
  return (
    <div className="flex-1">
      <h3 className="mb-1 text-sm font-semibold">{label}</h3>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-zinc-300 dark:border-zinc-700">
            <th className="py-1 pr-2">#</th>
            <th className="py-1 pr-2">Card</th>
            <th className="py-1 pr-2">Base</th>
            <th className="py-1 pr-2">Final</th>
            <th className="py-1 pr-2">Negated</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c, i) => (
            <tr key={c.instanceId} className="border-b border-zinc-100 dark:border-zinc-800">
              <td className="py-1 pr-2 text-zinc-500">{i + 1}</td>
              <td className="py-1 pr-2">{CARD_DEFS[c.cardId].name}</td>
              <td className="py-1 pr-2">{c.baseValue}</td>
              <td className="py-1 pr-2 font-semibold">{c.finalValue}</td>
              <td className="py-1 pr-2">{c.negated ? "yes" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndScreen({ state }: { state: GameState }) {
  const result = state.result!;
  const { cards } = resolveBoard(state.board, state.config.boardBounds, state.round);

  const orderIndex = new Map(state.placementOrder.map((id, i) => [id, i]));
  const byTurnPlayed = (ownerId: string) =>
    cards
      .filter((c) => c.ownerId === ownerId)
      .sort((a, b) => (orderIndex.get(a.instanceId) ?? 0) - (orderIndex.get(b.instanceId) ?? 0));

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h2 className="text-lg font-semibold">
        Game over —{" "}
        {result.winnerIds.length > 1 ? "tie!" : result.winnerIds[0] === HUMAN ? "you win!" : "AI wins."}
      </h2>
      <div className="flex gap-6 text-sm">
        <span>You: {result.scores[HUMAN]}</span>
        <span>AI: {result.scores[AI]}</span>
      </div>
      <div className="flex flex-col gap-6 sm:flex-row">
        <PlayerTable label="You" cards={byTurnPlayed(HUMAN)} />
        <PlayerTable label="AI" cards={byTurnPlayed(AI)} />
      </div>
    </div>
  );
}
