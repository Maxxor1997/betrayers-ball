"use client";

import { useEffect, useRef, useState } from "react";
import { CARD_DEFS } from "@/lib/content/cards";
import { randomCenterEffectPool } from "@/lib/content/centerEffects";
import { AI_NAMES, playerAccentClass } from "@/lib/config/players";
import { chooseGreedyAiAction } from "@/lib/ai/greedyAi";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { ResolutionResult, resolveBoard, ResolvedCard } from "@/lib/engine/resolution";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, isFlipUnlocked, mustPass } from "@/lib/engine/turns";
import { CardId, CenterEffectId, GameAction, GameState, Position, posKey } from "@/lib/engine/types";
import { BoardGrid } from "@/app/components/Board";
import { Hand } from "@/app/components/Hand";
import { GameStatusPanel } from "@/app/components/GameStatusPanel";
import { EndScreen } from "@/app/components/EndScreen";

const SELF = "self";
const DRAG_MIME = "application/x-playtest-card-instance-id";

function nameFor(state: GameState, ownerId: string): string {
  if (ownerId === SELF) return "You";
  const aiIndex = state.players.filter((p) => p.id !== SELF).findIndex((p) => p.id === ownerId);
  return AI_NAMES[aiIndex] ?? `AI ${aiIndex + 1}`;
}

function newGameState(playerCount: number, centerEffect: CenterEffectId | "random"): GameState {
  const playerIds = [SELF, ...Array.from({ length: playerCount - 1 }, (_, i) => `ai${i}`)];
  const aiPlayerIds = playerIds.filter((id) => id !== SELF);
  const pool = randomCenterEffectPool(playerCount);
  const resolvedEffect = centerEffect === "random" ? pool[Math.floor(Math.random() * pool.length)] : centerEffect;
  const config = configForPlayerCount(playerCount, resolvedEffect);
  const firstPlayerIndex = Math.floor(Math.random() * playerIds.length);
  return createGame(playerIds, config, undefined, aiPlayerIds, firstPlayerIndex);
}

/**
 * A real playable game embedded directly in the playtest page -- "including myself in
 * the sim" means playing repeatedly against the same greedy AI the bulk simulator
 * uses, with each finished game folded into the exact same running stats table
 * (`onGameEnded`), not a separate one. Deliberately smaller than /play's own Game():
 * no card catalog, no board-state export, no mid-game reconfigure -- player count and
 * location are fixed to whatever the simulator's own config panel currently has
 * selected (see the `playerCount`/`centerEffect` props), so a self-played game and a
 * simulated one are directly comparable.
 */
export function PlaySelf({
  playerCount,
  centerEffect,
  onGameEnded,
}: {
  playerCount: number;
  centerEffect: CenterEffectId | "random";
  onGameEnded: (cards: ResolvedCard[], scores: Record<string, number>, roundsPlayed: number, resolvedCenterEffect: CenterEffectId) => void;
}) {
  const [state, setState] = useState<GameState | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [pendingFlip, setPendingFlip] = useState<{ instanceId: string; label: string } | null>(null);
  const [highlightedCardId, setHighlightedCardId] = useState<CardId | null>(null);
  // Guards against double-tallying the same finished game -- the "ended" effect below
  // can re-run (e.g. a parent re-render) while `state` is still the same ended game.
  const talliedRef = useRef(false);

  const isHumanTurn = !!state && state.phase === "playing" && currentPlayerId(state) === SELF;
  const isAiTurn = !!state && state.phase === "playing" && !isHumanTurn;
  const isVoting = state?.phase === "voting";
  const humanVotePending = isVoting && !(SELF in state.votes);

  function dispatch(action: GameAction) {
    setState((prev) => {
      if (!prev) return prev;
      try {
        return applyAction(prev, action);
      } catch (err) {
        console.error("Illegal action rejected by engine:", err);
        return prev;
      }
    });
  }

  // Drive AI turns, same pacing as /play.
  useEffect(() => {
    if (!isAiTurn || !state) return;
    const timer = setTimeout(() => {
      const action = chooseGreedyAiAction(state, currentPlayerId(state));
      dispatch(action);
    }, 350);
    return () => clearTimeout(timer);
  }, [state, isAiTurn]);

  // Tally exactly once, the moment a game reaches "ended".
  useEffect(() => {
    if (!state || state.phase !== "ended" || talliedRef.current) return;
    talliedRef.current = true;
    const result = resolveBoard(
      state.board,
      state.config.boardBounds,
      state.round,
      state.config.centerEffect,
      state.players.map((p) => p.id)
    );
    onGameEnded(result.cards, state.result!.scores, state.round, state.config.centerEffect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function startGame() {
    talliedRef.current = false;
    setSelectedInstanceId(null);
    setDragOverKey(null);
    setPendingFlip(null);
    setState(newGameState(playerCount, centerEffect));
  }

  if (!state) {
    return (
      <div className="flex w-full flex-col items-center gap-3 rounded-lg border border-dashed border-zinc-300 p-6 text-center dark:border-zinc-700">
        <p className="text-sm text-zinc-500">
          Play {playerCount}p at {centerEffect === "random" ? "a random location" : "the configured location"} yourself -- each finished game is
          added to the same stats table above.
        </p>
        <button onClick={startGame} className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black">
          Start a game
        </button>
      </div>
    );
  }

  const legalCells = getLegalPlacementCells(state);
  const legalCellKeys = new Set(legalCells.map(posKey));
  const flipTargetIds = new Set((isHumanTurn ? getLegalFlipTargets(state) : []).map((c) => c.instanceId));
  const flipUnlocked = isFlipUnlocked(state.round, state.config);
  const humanMustPass = isHumanTurn && mustPass(state);
  const human = state.players.find((p) => p.id === SELF)!;

  function placeCard(instanceId: string, pos: Position) {
    if (!legalCellKeys.has(posKey(pos))) return;
    dispatch({ type: "place", playerId: SELF, instanceId, position: pos });
    setSelectedInstanceId(null);
  }

  function handleBoardCellClick(pos: Position) {
    if (!isHumanTurn) return;
    const key = posKey(pos);
    const occupant = state!.board.get(key);
    if (occupant) {
      if (!selectedInstanceId && !occupant.faceUp && flipTargetIds.has(occupant.instanceId)) {
        const label =
          occupant.ownerId === SELF
            ? `your ${CARD_DEFS[occupant.cardId].name} (${CARD_DEFS[occupant.cardId].base})`
            : `${nameFor(state!, occupant.ownerId)}'s face-down card`;
        setPendingFlip({ instanceId: occupant.instanceId, label });
      }
      return;
    }
    if (selectedInstanceId) placeCard(selectedInstanceId, pos);
  }

  const endResult: ResolutionResult | null =
    state.phase === "ended"
      ? resolveBoard(
          state.board,
          state.config.boardBounds,
          state.round,
          state.config.centerEffect,
          state.players.map((p) => p.id)
        )
      : null;
  const resolvedCards = endResult ? new Map(endResult.cards.map((c) => [c.instanceId, c])) : undefined;

  return (
    <div className="flex w-full flex-1 flex-col gap-6 lg:flex-row lg:items-start lg:justify-center">
      <div className="flex min-w-0 flex-1 flex-col items-center gap-6">
        <p className="min-h-[1.25rem] text-sm">
          {state.phase === "playing"
            ? isHumanTurn
              ? selectedInstanceId
                ? "Tap a highlighted cell to place the selected card (or just drag it there)."
                : "Drag a card from your hand onto a highlighted cell to place it."
              : `${nameFor(state, currentPlayerId(state))} is thinking…`
            : isVoting && !humanVotePending && "Tallying votes…"}
        </p>

        <BoardGrid
          state={state}
          viewerId={SELF}
          nameFor={(id) => nameFor(state, id)}
          legalCellKeys={legalCellKeys}
          flipTargetIds={flipTargetIds}
          selectedInstanceId={selectedInstanceId}
          dragOverKey={dragOverKey}
          revealAll={state.phase === "ended"}
          resolvedCards={resolvedCards}
          highlightedCardId={highlightedCardId}
          onCellClick={handleBoardCellClick}
          onCellDragOver={(e, key) => {
            if (!isHumanTurn || !legalCellKeys.has(key)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOverKey(key);
          }}
          onCellDragLeave={() => setDragOverKey(null)}
          onCellDrop={(e, pos) => {
            e.preventDefault();
            setDragOverKey(null);
            if (!isHumanTurn) return;
            const instanceId = e.dataTransfer.getData(DRAG_MIME);
            if (instanceId) placeCard(instanceId, pos);
          }}
        />

        {(state.phase === "playing" || state.phase === "voting") && (
          <div className="flex w-full flex-col items-center gap-3">
            <Hand
              cards={human.hand}
              selectedInstanceId={selectedInstanceId}
              onCardClick={(id) => {
                if (!isHumanTurn) return;
                setSelectedInstanceId((prev) => (prev === id ? null : id));
              }}
              onCardDragStart={(e, id) => {
                if (!isHumanTurn) return;
                e.dataTransfer.setData(DRAG_MIME, id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onHoverCardId={setHighlightedCardId}
              disabled={!isHumanTurn}
              ownerAccentClass={playerAccentClass(state.players, SELF)}
            />
            {humanMustPass && (
              <button
                onClick={() => dispatch({ type: "pass", playerId: SELF })}
                className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black"
              >
                No legal move — Pass
              </button>
            )}
          </div>
        )}

        {state.phase === "ended" && endResult && (
          <EndScreen
            state={state}
            result={endResult}
            viewerId={SELF}
            nameFor={(id) => nameFor(state, id)}
            footer={
              <button
                onClick={startGame}
                className="shrink-0 rounded-full bg-zinc-900 px-4 py-1.5 text-sm whitespace-nowrap text-white dark:bg-zinc-100 dark:text-black"
              >
                Play another
              </button>
            }
          />
        )}

        {humanVotePending && (
          <div className="fixed top-20 left-1/2 z-50 w-[min(90vw,20rem)] -translate-x-1/2 rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            <p className="mb-2 font-medium">Vote: end the game now?</p>
            <p className="mb-2 text-xs text-zinc-500">
              Round {state.round} of {state.config.roundCap}. Everyone votes privately; a majority is needed to end (ties continue).
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => dispatch({ type: "castVote", playerId: SELF, vote: false })}
                className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Keep playing
              </button>
              <button
                onClick={() => dispatch({ type: "castVote", playerId: SELF, vote: true })}
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
              <button
                onClick={() => {
                  dispatch({ type: "flip", playerId: SELF, instanceId: pendingFlip.instanceId });
                  setPendingFlip(null);
                }}
                className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black"
              >
                Flip
              </button>
            </div>
          </div>
        )}
      </div>

      <GameStatusPanel
        state={state}
        viewerId={SELF}
        nameFor={(id) => nameFor(state, id)}
        flipUnlocked={flipUnlocked}
        isMyTurn={isHumanTurn}
        myMustPass={humanMustPass}
      />
    </div>
  );
}
