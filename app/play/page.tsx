"use client";

import { useEffect, useState } from "react";
import { CARD_DEFS } from "@/lib/engine/cards";
import { inBounds, isCenterPosition } from "@/lib/engine/board";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { resolveBoard, ResolvedCard } from "@/lib/engine/resolution";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, mustPass } from "@/lib/engine/turns";
import { CardInstance, GameAction, GameState, Position, posKey } from "@/lib/engine/types";
import { chooseAiAction } from "@/lib/ai/randomAi";

const HUMAN = "human";
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

const PLAYER_COLOR_CLASSES = [
  "border-blue-500 bg-blue-50 dark:bg-blue-950",
  "border-red-500 bg-red-50 dark:bg-red-950",
  "border-purple-500 bg-purple-50 dark:bg-purple-950",
  "border-orange-500 bg-orange-50 dark:bg-orange-950",
  "border-teal-500 bg-teal-50 dark:bg-teal-950",
  "border-pink-500 bg-pink-50 dark:bg-pink-950",
];

const DRAG_MIME = "application/x-card-instance-id";

function buildPlayerIds(playerCount: number): string[] {
  return [HUMAN, ...Array.from({ length: playerCount - 1 }, (_, i) => `ai-${i + 1}`)];
}

function newGameState(playerCount: number): GameState {
  const playerIds = buildPlayerIds(playerCount);
  const aiPlayerIds = playerIds.filter((id) => id !== HUMAN);
  return createGame(playerIds, configForPlayerCount(playerCount), undefined, aiPlayerIds);
}

const AI_NAMES = [
  "Sir Loin of Beef",
  "Baron von Bluffalo",
  "Duchess Doomscroll",
  "Count Cardigan",
  "Earl of Awkward",
  "Viscount Vibecheck",
];

function ownerDisplayName(state: GameState, ownerId: string): string {
  if (ownerId === HUMAN) return "You";
  const aiIndex = state.players.filter((p) => p.id !== HUMAN).findIndex((p) => p.id === ownerId);
  return AI_NAMES[aiIndex] ?? `AI ${aiIndex + 1}`;
}

function ownerColorClass(state: GameState, ownerId: string): string {
  const idx = state.players.findIndex((p) => p.id === ownerId);
  return PLAYER_COLOR_CLASSES[idx] ?? "border-zinc-400";
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
  const [playerCount, setPlayerCount] = useState(2);
  const [state, setState] = useState<GameState>(() => newGameState(2));
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [pendingFlip, setPendingFlip] = useState<{ instanceId: string; label: string } | null>(null);
  // Player count is only ever chosen from this setup popup (opened by "New game"),
  // never editable while a game is in progress.
  const [newGameSetup, setNewGameSetup] = useState<{ playerCount: number } | null>(null);

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
  const isAiTurn = state.phase === "playing" && !isHumanTurn;
  const isVoting = state.phase === "voting";
  const humanVotePending = isVoting && !(HUMAN in state.votes);

  const legalCells = isHumanTurn ? getLegalPlacementCells(state) : [];
  const legalCellKeys = new Set(legalCells.map(posKey));
  const flipTargetIds = new Set((isHumanTurn ? getLegalFlipTargets(state) : []).map((c) => c.instanceId));
  const flipUnlocked = state.round >= state.config.flipUnlockRound;
  const humanMustPass = isHumanTurn && mustPass(state);

  // Drive the AI's turn(s) automatically. A turn can be up to two actions (an
  // optional flip, then a place/pass); this effect re-fires after each one while
  // it's still an AI's turn, so both actions play out with a short pause between.
  useEffect(() => {
    if (!isAiTurn) return;
    const timer = setTimeout(() => {
      const action = chooseAiAction(state, currentPlayerId(state));
      dispatch(action);
    }, 550);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, isAiTurn]);

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
        // Don't reveal an opponent's card identity in the confirmation -- that would
        // leak hidden info before the flip is even confirmed. Your own card is fine,
        // since you already know it (see the hover reveal).
        const label =
          occupant.ownerId === HUMAN
            ? `your ${CARD_DEFS[occupant.cardId].name} (${CARD_DEFS[occupant.cardId].base})`
            : `${ownerDisplayName(state, occupant.ownerId)}'s face-down card`;
        setPendingFlip({ instanceId: occupant.instanceId, label });
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

  function handleCastVote(vote: boolean) {
    dispatch({ type: "castVote", playerId: HUMAN, vote });
  }

  function openNewGameSetup() {
    setNewGameSetup({ playerCount });
  }

  function confirmNewGame() {
    if (!newGameSetup) return;
    setPlayerCount(newGameSetup.playerCount);
    setState(newGameState(newGameSetup.playerCount));
    setSelectedInstanceId(null);
    setPendingFlip(null);
    setNewGameSetup(null);
  }

  function confirmFlip() {
    if (!pendingFlip) return;
    dispatch({ type: "flip", playerId: HUMAN, instanceId: pendingFlip.instanceId });
    setPendingFlip(null);
  }

  const human = state.players.find((p) => p.id === HUMAN)!;

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <header className="flex w-full max-w-4xl flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Board Game — engine playtest</h1>
          <p className="text-sm text-zinc-500">
            Round {state.round} / {state.config.roundCap} · {flipUnlocked ? "flipping unlocked" : "flipping locks at round " + state.config.flipUnlockRound}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-zinc-500">{playerCount} players</span>
          <button
            onClick={openNewGameSetup}
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
            : `${ownerDisplayName(state, currentPlayerId(state))} is thinking…`}
        </p>
      )}

      {isVoting && !humanVotePending && <p className="text-sm">Tallying votes…</p>}

      <BoardGrid
        state={state}
        legalCellKeys={legalCellKeys}
        flipTargetIds={flipTargetIds}
        selectedInstanceId={selectedInstanceId}
        dragOverKey={dragOverKey}
        revealAll={state.phase === "ended"}
        onCellClick={handleBoardCellClick}
        onCellDragOver={handleCellDragOver}
        onCellDragLeave={() => setDragOverKey(null)}
        onCellDrop={handleCellDrop}
      />

      {state.phase === "ended" && (
        <p className="-mt-3 text-xs text-zinc-500">Faded text = was face-down during play</p>
      )}

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

      {humanVotePending && (
        <div className="fixed top-20 left-1/2 z-50 w-[min(90vw,20rem)] -translate-x-1/2 rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <p className="mb-2 font-medium">Vote: end the game now?</p>
          <p className="mb-2 text-xs text-zinc-500">
            Round {state.round} of {state.config.roundCap}. Everyone votes privately; a majority is needed to end (ties
            continue).
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
          <p className="mb-2">
            Flip {pendingFlip.label} face-up? This is permanent and uses your one flip for the turn.
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setPendingFlip(null)}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={confirmFlip}
              className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black"
            >
              Flip
            </button>
          </div>
        </div>
      )}

      {newGameSetup && (
        <div className="fixed top-20 left-1/2 z-50 w-[min(90vw,20rem)] -translate-x-1/2 rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <p className="mb-2 font-medium">Start a new game</p>
          <label className="mb-3 flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            Players
            <select
              value={newGameSetup.playerCount}
              onChange={(e) => setNewGameSetup({ playerCount: Number(e.target.value) })}
              className="rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm dark:border-zinc-700"
            >
              {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((n) => (
                <option key={n} value={n}>
                  {n} (you + {n - 1} AI)
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setNewGameSetup(null)}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={confirmNewGame}
              className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black"
            >
              Start
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BoardGrid({
  state,
  legalCellKeys,
  flipTargetIds,
  selectedInstanceId,
  dragOverKey,
  revealAll,
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
  revealAll: boolean;
  onCellClick: (pos: Position) => void;
  onCellDragOver: (e: React.DragEvent, key: string) => void;
  onCellDragLeave: () => void;
  onCellDrop: (e: React.DragEvent, pos: Position) => void;
}) {
  const { width, height } = state.config.boardBounds;
  const rows = Array.from({ length: height }, (_, y) => y);
  const cols = Array.from({ length: width }, (_, x) => x);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

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
            const displayFaceUp = revealAll || card.faceUp;
            // At game end, cards that were face-down during play are shown with faded
            // text instead of a separate badge -- distinguishable without being loud.
            const faded = revealAll && !card.faceUp;
            const def = CARD_DEFS[card.cardId];
            // Hovering a known card (revealed, or your own even if still face-down)
            // shows its full effect text -- a UI convenience, not a state change. An
            // opponent's still-hidden card shows nothing, so no info leaks before a flip.
            // The hover listener lives on the wrapper div (not the button) so it still
            // fires even when the button itself is disabled.
            const tooltipContent = displayFaceUp
              ? `${def.name} (${def.base}) — ${def.fullText}`
              : card.ownerId === HUMAN
                ? `${def.name} (${def.base}) — ${def.fullText} — only visible to you`
                : null;
            return (
              <div
                key={key}
                className="relative"
                onMouseEnter={() => setHoveredKey(key)}
                onMouseLeave={() => setHoveredKey((prev) => (prev === key ? null : prev))}
              >
                <button
                  onClick={() => onCellClick(pos)}
                  disabled={!clickable}
                  title={clickable ? "Tap to flip face-up" : undefined}
                  className={`flex h-20 w-20 flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 text-center ${ownerColorClass(state, card.ownerId)} ${
                    clickable ? "cursor-pointer ring-2 ring-amber-400" : ""
                  }`}
                >
                  {displayFaceUp ? (
                    <>
                      <span className={`text-[10px] leading-tight break-words ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}>
                        {def.name}
                      </span>
                      <span className={`text-lg font-bold leading-none ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}>
                        {def.base}
                      </span>
                    </>
                  ) : (
                    <span className="text-xl">🂠</span>
                  )}
                </button>
                {tooltipContent && hoveredKey === key && (
                  <div className="pointer-events-none absolute -top-9 left-1/2 z-10 w-max max-w-[12rem] -translate-x-1/2 rounded bg-zinc-900 px-2 py-1 text-center text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black">
                    {tooltipContent}
                  </div>
                )}
              </div>
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
  const [hoveredInstanceId, setHoveredInstanceId] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap justify-center gap-2">
      {sortedCards.map((card) => {
        const def = CARD_DEFS[card.cardId];
        const selected = card.instanceId === selectedInstanceId;
        return (
          <div
            key={card.instanceId}
            className="relative"
            onMouseEnter={() => setHoveredInstanceId(card.instanceId)}
            onMouseLeave={() => setHoveredInstanceId((prev) => (prev === card.instanceId ? null : prev))}
          >
            <button
              onClick={() => onCardClick(card.instanceId)}
              draggable={!disabled}
              onDragStart={(e) => onCardDragStart(e, card.instanceId)}
              disabled={disabled}
              className={`flex h-32 w-24 flex-col items-center justify-center gap-1 rounded-md border-2 p-1.5 text-center ${
                disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"
              } ${selected ? "border-amber-500 bg-amber-50 dark:bg-amber-950" : "border-zinc-300 dark:border-zinc-700"}`}
            >
              <span className="text-[10px] font-semibold leading-tight break-words">{def.name}</span>
              <span className="text-xl font-bold leading-none">{def.base}</span>
              <span className="text-[9px] leading-tight break-words text-zinc-500 dark:text-zinc-400">{def.text}</span>
            </button>
            {hoveredInstanceId === card.instanceId && (
              <div className="pointer-events-none absolute -top-9 left-1/2 z-10 w-max max-w-[12rem] -translate-x-1/2 rounded bg-zinc-900 px-2 py-1 text-center text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black">
                {def.fullText}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PlayerTable({ label, cards }: { label: string; cards: ResolvedCard[] }) {
  return (
    <div className="min-w-[11rem] flex-1">
      <h3 className="mb-1 text-sm font-semibold">{label}</h3>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-zinc-300 dark:border-zinc-700">
            <th className="py-1 pr-2">#</th>
            <th className="py-1 pr-2">Card</th>
            <th className="py-1 pr-2">Initial</th>
            <th className="py-1 pr-2">Final</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c, i) => (
            <tr key={c.instanceId} className="border-b border-zinc-100 dark:border-zinc-800">
              <td className="py-1 pr-2 text-zinc-500">{i + 1}</td>
              <td className="py-1 pr-2">{CARD_DEFS[c.cardId].name}</td>
              <td className="py-1 pr-2">{c.baseValue}</td>
              <td className="py-1 pr-2 font-semibold">{c.finalValue}</td>
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

  const winnerLabel =
    result.winnerIds.length > 1
      ? "tie!"
      : result.winnerIds[0] === HUMAN
        ? "you win!"
        : `${ownerDisplayName(state, result.winnerIds[0])} wins.`;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-4 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h2 className="text-lg font-semibold">Game over — {winnerLabel}</h2>
      <div className="flex flex-wrap gap-6 text-sm">
        {state.players.map((p) => (
          <span key={p.id}>
            {ownerDisplayName(state, p.id)}: {result.scores[p.id]}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-6">
        {state.players.map((p) => (
          <PlayerTable key={p.id} label={ownerDisplayName(state, p.id)} cards={byTurnPlayed(p.id)} />
        ))}
      </div>
    </div>
  );
}
