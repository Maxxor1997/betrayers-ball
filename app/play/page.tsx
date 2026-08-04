"use client";

import { useEffect, useState } from "react";
import { CARD_DEFS } from "@/lib/engine/cards";
import { inBounds, isCenterPosition } from "@/lib/engine/board";
import { applyAction, createGame, DEFAULT_2P_CONFIG } from "@/lib/engine/game";
import { resolveBoard } from "@/lib/engine/resolution";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, mustPass } from "@/lib/engine/turns";
import { CardInstance, GameAction, GameState, Position, posKey } from "@/lib/engine/types";
import { chooseAiAction } from "@/lib/ai/randomAi";

const HUMAN = "human";
const AI = "ai";

const OWNER_STYLES: Record<string, string> = {
  [HUMAN]: "border-blue-500 bg-blue-50 dark:bg-blue-950",
  [AI]: "border-red-500 bg-red-50 dark:bg-red-950",
};

function newGameState(): GameState {
  return createGame([HUMAN, AI], DEFAULT_2P_CONFIG);
}

export default function PlayPage() {
  const [state, setState] = useState<GameState>(newGameState);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

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
        dispatch({ type: "flip", playerId: HUMAN, instanceId: occupant.instanceId });
      }
      return;
    }

    if (selectedInstanceId && legalCellKeys.has(key)) {
      dispatch({ type: "place", playerId: HUMAN, instanceId: selectedInstanceId, position: pos });
      setSelectedInstanceId(null);
    }
  }

  function handlePass() {
    if (!isHumanTurn) return;
    dispatch({ type: "pass", playerId: HUMAN });
  }

  function handleNewGame() {
    setState(newGameState());
    setSelectedInstanceId(null);
  }

  const human = state.players.find((p) => p.id === HUMAN)!;

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <header className="flex w-full max-w-3xl items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Board Game — engine playtest</h1>
          <p className="text-sm text-zinc-500">
            Round {state.round} / {state.config.roundCap} · {flipUnlocked ? "flipping unlocked" : "flipping locks at round " + state.config.flipUnlockRound}
          </p>
        </div>
        <button
          onClick={handleNewGame}
          className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          New game
        </button>
      </header>

      {state.phase === "playing" && (
        <p className="text-sm">
          {isHumanTurn
            ? selectedInstanceId
              ? "Tap a highlighted cell to place the selected card."
              : "Your turn — tap a card in your hand to select it, or tap a face-down card on the board to flip it."
            : "AI is thinking…"}
        </p>
      )}

      <BoardGrid
        state={state}
        legalCellKeys={legalCellKeys}
        flipTargetIds={flipTargetIds}
        selectedInstanceId={selectedInstanceId}
        onCellClick={handleBoardCellClick}
      />

      {state.phase === "playing" && (
        <div className="flex flex-col items-center gap-3">
          <Hand cards={human.hand} selectedInstanceId={selectedInstanceId} onCardClick={handleHandCardClick} disabled={!isHumanTurn} />
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
  onCellClick,
}: {
  state: GameState;
  legalCellKeys: Set<string>;
  flipTargetIds: Set<string>;
  selectedInstanceId: string | null;
  onCellClick: (pos: Position) => void;
}) {
  const { width, height, center } = state.config.boardBounds;
  const rows = Array.from({ length: height }, (_, y) => y);
  const cols = Array.from({ length: width }, (_, x) => x);

  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))` }}
    >
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
                className="flex h-16 w-16 items-center justify-center rounded-md border-2 border-dashed border-zinc-400 text-[10px] text-zinc-400"
              >
                center
              </div>
            );
          }

          if (card) {
            const clickable = !card.faceUp && flipTargetIds.has(card.instanceId) && !selectedInstanceId;
            return (
              <button
                key={key}
                onClick={() => onCellClick(pos)}
                disabled={!clickable}
                className={`flex h-16 w-16 flex-col items-center justify-center rounded-md border-2 text-xs ${OWNER_STYLES[card.ownerId] ?? "border-zinc-400"} ${
                  clickable ? "cursor-pointer ring-2 ring-amber-400" : ""
                }`}
                title={clickable ? "Tap to flip face-up" : undefined}
              >
                {card.faceUp ? (
                  <>
                    <span className="font-medium leading-tight">{CARD_DEFS[card.cardId].name}</span>
                    <span className="text-base font-bold">{CARD_DEFS[card.cardId].base}</span>
                  </>
                ) : (
                  <span className="text-lg">🂠</span>
                )}
              </button>
            );
          }

          return (
            <button
              key={key}
              onClick={() => onCellClick(pos)}
              disabled={!isLegal}
              className={`h-16 w-16 rounded-md border ${
                isLegal ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950" : "border-zinc-200 dark:border-zinc-800"
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
  disabled,
}: {
  cards: CardInstance[];
  selectedInstanceId: string | null;
  onCardClick: (instanceId: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {cards.map((card) => {
        const def = CARD_DEFS[card.cardId];
        const selected = card.instanceId === selectedInstanceId;
        return (
          <button
            key={card.instanceId}
            onClick={() => onCardClick(card.instanceId)}
            disabled={disabled}
            className={`flex h-16 w-14 flex-col items-center justify-center rounded-md border-2 text-xs ${
              selected ? "border-amber-500 bg-amber-50 dark:bg-amber-950" : "border-zinc-300 dark:border-zinc-700"
            }`}
          >
            <span className="leading-tight">{def.name}</span>
            <span className="text-base font-bold">{def.base}</span>
          </button>
        );
      })}
    </div>
  );
}

function EndScreen({ state }: { state: GameState }) {
  const result = state.result!;
  const { cards } = resolveBoard(state.board, state.config.boardBounds, state.round);
  const sorted = [...cards].sort((a, b) => b.finalValue - a.finalValue);

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h2 className="text-lg font-semibold">
        Game over —{" "}
        {result.winnerIds.length > 1 ? "tie!" : result.winnerIds[0] === HUMAN ? "you win!" : "AI wins."}
      </h2>
      <div className="flex gap-6 text-sm">
        <span>You: {result.scores[HUMAN]}</span>
        <span>AI: {result.scores[AI]}</span>
      </div>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-zinc-300 dark:border-zinc-700">
            <th className="py-1 pr-2">Card</th>
            <th className="py-1 pr-2">Owner</th>
            <th className="py-1 pr-2">Base</th>
            <th className="py-1 pr-2">Final</th>
            <th className="py-1 pr-2">Negated</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.instanceId} className="border-b border-zinc-100 dark:border-zinc-800">
              <td className="py-1 pr-2">{CARD_DEFS[c.cardId].name}</td>
              <td className="py-1 pr-2">{c.ownerId === HUMAN ? "You" : "AI"}</td>
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
