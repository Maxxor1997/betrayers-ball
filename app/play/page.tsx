"use client";

import { useEffect, useState } from "react";
import { ALL_CARD_IDS, CARD_DEFS, copiesForPlayerCount } from "@/lib/content/cards";
import { inBounds, isCenterPosition } from "@/lib/engine/board";
import {
  CENTER_EFFECTS,
  centerEffectDescription,
  isAvailableAtPlayerCount,
  randomCenterEffectPool,
  selectableCenterEffects,
} from "@/lib/content/centerEffects";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { resolveBoard } from "@/lib/engine/resolution";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, isFlipUnlocked, mustPass } from "@/lib/engine/turns";
import { CardBucket, CenterEffectId, GameAction, GameState, Position, posKey } from "@/lib/engine/types";
import { chooseGreedyAiAction } from "@/lib/ai/greedyAi";
import { AI_NAMES, MAX_PLAYERS, MIN_PLAYERS, PLAYER_BORDER_COLOR_CLASSES, PLAYER_COLOR_CLASSES, PLAYER_TEXT_COLOR_CLASSES } from "@/lib/config/players";
import { BoardGridProps, HandProps, NewGameSetup, PendingFlip, PlayerTableProps } from "./types";

const HUMAN = "human";

const DRAG_MIME = "application/x-card-instance-id";

function buildPlayerIds(playerCount: number): string[] {
  return [HUMAN, ...Array.from({ length: playerCount - 1 }, (_, i) => `ai-${i + 1}`)];
}

function newGameState(playerCount: number, centerEffect: CenterEffectId): GameState {
  const playerIds = buildPlayerIds(playerCount);
  const aiPlayerIds = playerIds.filter((id) => id !== HUMAN);
  const config = { ...configForPlayerCount(playerCount), centerEffect };
  const firstPlayerIndex = Math.floor(Math.random() * playerIds.length);
  return createGame(playerIds, config, undefined, aiPlayerIds, firstPlayerIndex);
}

function ownerDisplayName(state: GameState, ownerId: string): string {
  if (ownerId === HUMAN) return "You";
  const aiIndex = state.players.filter((p) => p.id !== HUMAN).findIndex((p) => p.id === ownerId);
  return AI_NAMES[aiIndex] ?? `AI ${aiIndex + 1}`;
}

function ownerColorClass(state: GameState, ownerId: string): string {
  const idx = state.players.findIndex((p) => p.id === ownerId);
  return PLAYER_COLOR_CLASSES[idx] ?? "border-zinc-400";
}

function ownerTextColorClass(state: GameState, ownerId: string): string {
  const idx = state.players.findIndex((p) => p.id === ownerId);
  return PLAYER_TEXT_COLOR_CLASSES[idx] ?? "text-zinc-500";
}

function ownerBorderColorClass(state: GameState, ownerId: string): string {
  const idx = state.players.findIndex((p) => p.id === ownerId);
  return PLAYER_BORDER_COLOR_CLASSES[idx] ?? "border-zinc-300 dark:border-zinc-700";
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
  const [state, setState] = useState<GameState>(() => newGameState(2, "none"));
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [pendingFlip, setPendingFlip] = useState<PendingFlip | null>(null);
  // Player count and center effect are only ever chosen from this setup popup (opened
  // by "New game"), never editable while a game is in progress.
  const [newGameSetup, setNewGameSetup] = useState<NewGameSetup | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);

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
  const flipUnlocked = isFlipUnlocked(state.round, state.config);
  const humanMustPass = isHumanTurn && mustPass(state);

  // Drive the AI's turn(s) automatically. A turn can be up to two actions (an
  // optional flip, then a place/pass); this effect re-fires after each one while
  // it's still an AI's turn, so both actions play out with a short pause between.
  useEffect(() => {
    if (!isAiTurn) return;
    const timer = setTimeout(() => {
      const action = chooseGreedyAiAction(state, currentPlayerId(state));
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
    setNewGameSetup({ playerCount, centerEffect: "random" });
  }

  function confirmNewGame() {
    if (!newGameSetup) return;
    const pool = randomCenterEffectPool(newGameSetup.playerCount);
    const centerEffect: CenterEffectId =
      newGameSetup.centerEffect === "random" ? pool[Math.floor(Math.random() * pool.length)] : newGameSetup.centerEffect;
    setPlayerCount(newGameSetup.playerCount);
    setState(newGameState(newGameSetup.playerCount, centerEffect));
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
    <div className="flex flex-1 flex-col gap-6 px-4 py-8 lg:flex-row lg:items-start lg:justify-center">
      <CardCatalog playerCount={state.config.playerCount} />
      <div className="flex min-w-0 flex-1 flex-col items-center gap-6">
      <header className="flex w-full max-w-4xl flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Board Game — engine playtest</h1>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-zinc-500">{playerCount} players</span>
          <button
            onClick={() => setShowInstructions(true)}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            How to play
          </button>
          <button
            onClick={openNewGameSetup}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            New game
          </button>
        </div>
      </header>

      {showInstructions && <InstructionsModal onClose={() => setShowInstructions(false)} />}

      {state.phase === "playing" && (
        <p className="text-sm">
          {isHumanTurn
            ? selectedInstanceId
              ? "Tap a highlighted cell to place the selected card (or just drag it there)."
              : "Your turn — optionally tap a face-down card on the board to flip it first, then drag a hand card onto a highlighted cell to place it."
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

      {(state.phase === "playing" || state.phase === "voting") && (
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
          <label className="mb-2 flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            Players
            <select
              value={newGameSetup.playerCount}
              onChange={(e) => {
                const playerCount = Number(e.target.value);
                // Reset to "random" if the effect currently picked isn't available at
                // the new player count -- e.g. an effect that's only for larger boards.
                const centerEffect =
                  newGameSetup.centerEffect === "random" ||
                  newGameSetup.centerEffect === "none" ||
                  isAvailableAtPlayerCount(newGameSetup.centerEffect, playerCount)
                    ? newGameSetup.centerEffect
                    : "random";
                setNewGameSetup({ ...newGameSetup, playerCount, centerEffect });
              }}
              className="rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm dark:border-zinc-700"
            >
              {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((n) => (
                <option key={n} value={n}>
                  {n} (you + {n - 1} AI)
                </option>
              ))}
            </select>
          </label>
          <label className="mb-3 flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            Center effect
            <select
              value={newGameSetup.centerEffect}
              onChange={(e) => setNewGameSetup({ ...newGameSetup, centerEffect: e.target.value as CenterEffectId | "random" })}
              className="rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm dark:border-zinc-700"
            >
              <option value="random">Random</option>
              <option value="none">None</option>
              {selectableCenterEffects(newGameSetup.playerCount).map((id) => (
                <option key={id} value={id}>
                  {CENTER_EFFECTS[id].label}
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
      <GameStatusPanel state={state} flipUnlocked={flipUnlocked} isHumanTurn={isHumanTurn} humanMustPass={humanMustPass} />
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
}: BoardGridProps) {
  const { width, height } = state.config.boardBounds;
  const rows = Array.from({ length: height }, (_, y) => y);
  const cols = Array.from({ length: width }, (_, x) => x);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  // Cells are sized to fill their grid column (aspect-square, no fixed px) rather than
  // a fixed h-20 w-20 -- with wider boards (7-8p can be 13-15 columns) a fixed cell
  // size would force the grid past the available width and cells would overlap/clip.
  // The container's own max-width caps cells at a comfortable 5rem when there's room,
  // but is otherwise bounded by `w-full`, so minmax(0, 1fr) columns (and their
  // w-full children) shrink together to fit whatever space is actually available.
  const CELL_SIZE_PX = 80;
  const GAP_PX = 6;

  return (
    <div
      className="grid w-full gap-1.5"
      style={{
        gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))`,
        maxWidth: `${width * CELL_SIZE_PX + (width - 1) * GAP_PX}px`,
      }}
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
                className="relative"
                onMouseEnter={() => setHoveredKey(key)}
                onMouseLeave={() => setHoveredKey((prev) => (prev === key ? null : prev))}
              >
                <div className="flex aspect-square w-full items-center justify-center rounded-md border-2 border-dashed border-zinc-400 p-1 text-center text-[9px] leading-tight break-words text-zinc-400">
                  {CENTER_EFFECTS[state.config.centerEffect].label}
                </div>
                {hoveredKey === key && (
                  <div className="pointer-events-none absolute -top-9 left-1/2 z-10 w-max max-w-[14rem] -translate-x-1/2 rounded bg-zinc-900 px-2 py-1 text-center text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black">
                    {CENTER_EFFECTS[state.config.centerEffect].label} —{" "}
                    {centerEffectDescription(state.config.centerEffect, state.config)}
                  </div>
                )}
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
            const tooltipOwner = ownerDisplayName(state, card.ownerId);
            const tooltipDetail = displayFaceUp
              ? `${def.name} (${def.base}) — ${def.fullText}`
              : card.ownerId === HUMAN
                ? `${def.name} (${def.base}) — ${def.fullText} — only visible to you`
                : "face-down card";
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
                  className={`flex aspect-square w-full flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 text-center ${ownerColorClass(state, card.ownerId)} ${
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
                {hoveredKey === key && (
                  <div className="pointer-events-none absolute -top-12 left-1/2 z-10 w-max max-w-[12rem] -translate-x-1/2 rounded bg-zinc-900 px-2 py-1 text-center text-white shadow dark:bg-zinc-100 dark:text-black">
                    <div className="text-[10px] font-semibold leading-tight">{tooltipOwner}</div>
                    <div className="text-[10px] leading-tight">{tooltipDetail}</div>
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
              className={`aspect-square w-full rounded-md border transition-colors ${
                isLegal
                  ? dragOverKey === key
                    ? "border-emerald-600 bg-emerald-200 dark:bg-emerald-800"
                    : "border-emerald-300/70 bg-emerald-50/50 dark:border-emerald-800/70 dark:bg-emerald-950/40"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            />
          );
        })
      )}
    </div>
  );
}

function RoundBadge({ round, roundCap }: { round: number; roundCap: number }) {
  return (
    <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-full border-2 border-zinc-400 dark:border-zinc-600">
      <span className="text-base leading-none font-bold">{round}</span>
      <span className="text-[9px] leading-none text-zinc-500">of {roundCap}</span>
    </div>
  );
}

/**
 * Label on top, its value in a boxed cell underneath -- `number` renders a compact
 * square cell (e.g. the round something unlocks/opens on), `text` renders a pill for
 * values that aren't a round number (e.g. "now").
 */
function StatusCell({ label, active, number, text }: { label: string; active: boolean; number?: number; text?: string }) {
  const toneClass = active
    ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
    : "border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400";

  return (
    <div className="flex w-full flex-col items-center gap-1">
      <span
        className={`text-[10px] font-semibold tracking-wide uppercase ${
          active ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500 dark:text-zinc-400"
        }`}
      >
        {label}
      </span>
      {number !== undefined ? (
        <span className={`flex h-8 w-8 items-center justify-center rounded-md border-2 text-sm font-bold ${toneClass}`}>
          {number}
        </span>
      ) : (
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium ${toneClass}`}>{text}</span>
      )}
    </div>
  );
}

function ChecklistItem({ done, disabled, label }: { done: boolean; disabled?: boolean; label: string }) {
  return (
    <div
      className={`flex items-start gap-1.5 text-xs ${
        disabled
          ? "text-zinc-400 line-through dark:text-zinc-600"
          : done
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-zinc-700 dark:text-zinc-300"
      }`}
    >
      <span>{done ? "☑" : "☐"}</span>
      {label}
    </div>
  );
}

/** Live checklist for the human's current turn -- ticks off the optional flip as soon as it's used. */
function TurnChecklist({
  isHumanTurn,
  hasFlippedThisTurn,
  flipUnlocked,
  mustPass,
}: {
  isHumanTurn: boolean;
  hasFlippedThisTurn: boolean;
  flipUnlocked: boolean;
  mustPass: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
        {isHumanTurn ? "Your turn" : "Waiting"}
      </span>
      <ChecklistItem done={hasFlippedThisTurn} disabled={!isHumanTurn || !flipUnlocked} label="Flip a card (optional)" />
      <ChecklistItem done={false} disabled={!isHumanTurn} label={mustPass ? "Pass (no legal move)" : "Place a card"} />
    </div>
  );
}

/** Compact status readout for the header: round, flip/vote availability, center effect, and the turn checklist. */
function GameStatusPanel({
  state,
  flipUnlocked,
  isHumanTurn,
  humanMustPass,
}: {
  state: GameState;
  flipUnlocked: boolean;
  isHumanTurn: boolean;
  humanMustPass: boolean;
}) {
  // Flip: label + either a round number (when there's a specific round to wait for)
  // or a text pill (already-resolved states with no single round to point at).
  let flipLabel: string;
  let flipNumber: number | undefined;
  let flipText: string | undefined;
  if (flipUnlocked) {
    flipLabel = "Flip unlocked";
    flipText = state.config.centerEffect === "pryingEyes" ? "opp. only" : "now";
  } else if (state.config.centerEffect === "shadowlands" && state.config.playerCount === 2) {
    flipLabel = "Flip locked";
    flipText = "all game";
  } else if (state.config.centerEffect === "shadowlands") {
    flipLabel = "Flip locked";
    flipText = "this rnd";
  } else {
    flipLabel = "Flip unlocks";
    flipNumber = state.config.flipUnlockRound;
  }

  const votingOpen = state.round >= state.config.minRoundFloor;
  const voteLabel = votingOpen ? "Voting open" : "Voting opens";

  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-8 lg:w-40 lg:self-start">
      <div className="flex flex-col items-center gap-4 rounded-xl border border-zinc-300 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950">
        <RoundBadge round={state.round} roundCap={state.config.roundCap} />
        <div className="flex w-full flex-col gap-3">
          <StatusCell label={flipLabel} active={flipUnlocked} number={flipNumber} text={flipText} />
          <StatusCell
            label={voteLabel}
            active={votingOpen}
            number={votingOpen ? undefined : state.config.minRoundFloor}
            text={votingOpen ? "now" : undefined}
          />
        </div>
        <div className="flex w-full flex-col items-center gap-1 text-center">
          <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Center</span>
          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            {CENTER_EFFECTS[state.config.centerEffect].label}
          </span>
        </div>
        {state.phase === "playing" && (
          <>
            <div className="h-px w-full shrink-0 bg-zinc-300 dark:bg-zinc-700" />
            <TurnChecklist
              isHumanTurn={isHumanTurn}
              hasFlippedThisTurn={state.hasFlippedThisTurn}
              flipUnlocked={flipUnlocked}
              mustPass={humanMustPass}
            />
          </>
        )}
      </div>
    </aside>
  );
}

const BUCKET_ORDER: CardBucket[] = ["Slam", "Engine", "Control"];

const BUCKET_DESCRIPTIONS: Record<CardBucket, string> = {
  Slam: "High base value with a built-in downside or condition that can cut it back down -- big numbers, but risky.",
  Engine: "Low base value that grows from board state or synergy with other cards -- value comes from setup, not the printed number.",
  Control: "Doesn't boost itself -- manipulates neighbors' values or bends the normal rules (negation, forced flips, zeroing).",
};

/**
 * Reference sidebar listing every card in the game, grouped by bucket, with its copy
 * count at the current game's player count -- lets a new player see the whole card
 * pool up front instead of only discovering cards as they're drawn. Shows every card
 * regardless of count (a card disabled or absent at this player count still appears,
 * just annotated "x0 in deck").
 */
function CardCatalog({ playerCount }: { playerCount: number }) {
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [hoveredBucket, setHoveredBucket] = useState<CardBucket | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<CardBucket>>(new Set());

  function toggleBucket(bucket: CardBucket) {
    setCollapsedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }

  if (collapsed) {
    return (
      <aside className="shrink-0 lg:sticky lg:top-8 lg:self-start">
        <button
          onClick={() => setCollapsed(false)}
          className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs whitespace-nowrap hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          ▶ Cards
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-full shrink-0 overflow-x-hidden lg:sticky lg:top-8 lg:w-48 lg:self-start lg:border-r-2 lg:border-zinc-400 lg:pr-4 dark:lg:border-zinc-600">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Card catalog <span className="font-normal text-zinc-500">({playerCount}p)</span>
        </h2>
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse"
          className="shrink-0 rounded-full border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          ◀
        </button>
      </div>
      <div className="flex flex-col gap-4 overflow-x-hidden lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
        {BUCKET_ORDER.map((bucket) => {
          const ids = ALL_CARD_IDS.filter((id) => CARD_DEFS[id].bucket === bucket).sort((a, b) => {
            const countDiff = copiesForPlayerCount(CARD_DEFS[b], playerCount) - copiesForPlayerCount(CARD_DEFS[a], playerCount);
            return countDiff !== 0 ? countDiff : CARD_DEFS[a].name.localeCompare(CARD_DEFS[b].name);
          });
          const bucketCollapsed = collapsedBuckets.has(bucket);
          return (
            <div key={bucket}>
              <div className="relative mb-1.5">
                <button
                  onClick={() => toggleBucket(bucket)}
                  onMouseEnter={() => setHoveredBucket(bucket)}
                  onMouseLeave={() => setHoveredBucket((prev) => (prev === bucket ? null : prev))}
                  className="flex w-full items-center gap-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  <span className="inline-block w-3 shrink-0">{bucketCollapsed ? "▶" : "▼"}</span>
                  {bucket}
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-zinc-400 text-[9px] normal-case text-zinc-400 dark:border-zinc-500 dark:text-zinc-500">
                    i
                  </span>
                </button>
                {hoveredBucket === bucket && (
                  <div className="pointer-events-none absolute top-full left-0 z-10 mt-1 w-full rounded bg-zinc-900 px-2 py-1 text-[10px] leading-tight normal-case text-white shadow dark:bg-zinc-100 dark:text-black">
                    {BUCKET_DESCRIPTIONS[bucket]}
                  </div>
                )}
              </div>
              {!bucketCollapsed && (
                <div className="flex flex-col gap-1.5">
                  {ids.map((id) => {
                    const def = CARD_DEFS[id];
                    const copies = copiesForPlayerCount(def, playerCount);
                    return (
                      <div
                        key={id}
                        className="relative flex min-w-0 items-center gap-2"
                        onMouseEnter={() => setHoveredCardId(id)}
                        onMouseLeave={() => setHoveredCardId((prev) => (prev === id ? null : prev))}
                      >
                        <div
                          className={`flex h-16 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 text-center ${
                            copies === 0
                              ? "border-zinc-200 opacity-50 dark:border-zinc-800"
                              : "border-zinc-300 dark:border-zinc-700"
                          }`}
                        >
                          <span className="text-[8px] font-semibold leading-tight break-words">{def.name}</span>
                          <span className="text-base font-bold leading-none">{def.base}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">
                            {def.name} <span className="text-zinc-500 dark:text-zinc-400">×{copies}</span>
                          </div>
                          <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">{def.text}</div>
                        </div>
                        {hoveredCardId === id && (
                          <div className="pointer-events-none absolute top-full left-0 z-10 mt-1 w-full rounded bg-zinc-900 px-2 py-1 text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black">
                            {def.fullText}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function Hand({ cards, selectedInstanceId, onCardClick, onCardDragStart, disabled }: HandProps) {
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

function PlayerTable({ label, score, colorClass, borderColorClass, cards, extraRow }: PlayerTableProps) {
  return (
    <div className={`min-w-[11rem] flex-1 border-l-2 pl-2 ${borderColorClass}`}>
      <h3 className={`mb-1 text-sm font-semibold ${colorClass}`}>
        {label}: {score}
      </h3>
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
          {extraRow && (
            <tr className="border-b border-zinc-100 italic dark:border-zinc-800">
              <td className="py-1 pr-2 text-zinc-500">—</td>
              <td className="py-1 pr-2">{extraRow.label}</td>
              <td className="py-1 pr-2">—</td>
              <td className="py-1 pr-2 font-semibold">{extraRow.value}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function EndScreen({ state }: { state: GameState }) {
  const result = state.result!;
  const playerIds = state.players.map((p) => p.id);
  const { cards, centerAward, kingslayerZeroed } = resolveBoard(
    state.board,
    state.config.boardBounds,
    state.round,
    state.config.centerEffect,
    playerIds
  );

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
      {centerAward && (
        <p className="-mb-2 text-xs text-zinc-500">
          Champion of the Weak: the center (value {centerAward.value}) went to {ownerDisplayName(state, centerAward.ownerId)}.
        </p>
      )}
      {kingslayerZeroed.length > 0 && (
        <p className="-mb-2 text-xs text-zinc-500">
          Kingslayer zeroed:{" "}
          {kingslayerZeroed
            .map((id) => {
              const c = cards.find((cc) => cc.instanceId === id)!;
              return `${CARD_DEFS[c.cardId].name} (${ownerDisplayName(state, c.ownerId)})`;
            })
            .join(", ")}
        </p>
      )}
      <div className="flex flex-wrap gap-6">
        {state.players.map((p) => (
          <PlayerTable
            key={p.id}
            label={ownerDisplayName(state, p.id)}
            score={result.scores[p.id]}
            colorClass={ownerTextColorClass(state, p.id)}
            borderColorClass={ownerBorderColorClass(state, p.id)}
            cards={byTurnPlayed(p.id)}
            extraRow={centerAward && centerAward.ownerId === p.id ? { label: "Center", value: centerAward.value } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-semibold text-white dark:bg-zinc-100 dark:text-black">
      {n}
    </span>
  );
}

function MiniBoard() {
  // A tiny mockup of the opening board: only the center tile's 4 orthogonal
  // neighbors are legal on an empty board, exactly like the real thing.
  const legal = new Set(["1,0", "0,1", "2,1", "1,2"]);
  const cells: string[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) cells.push(`${x},${y}`);

  return (
    <div className="grid w-max grid-cols-3 gap-1">
      {cells.map((key) => {
        if (key === "1,1") {
          return (
            <div
              key={key}
              className="flex h-8 w-8 items-center justify-center rounded border-2 border-dashed border-zinc-400 text-[7px] text-zinc-400"
            >
              center
            </div>
          );
        }
        return (
          <div
            key={key}
            className={`h-8 w-8 rounded border ${
              legal.has(key)
                ? "border-emerald-300/70 bg-emerald-50/50 dark:border-emerald-800/70 dark:bg-emerald-950/40"
                : "border-zinc-200 dark:border-zinc-800"
            }`}
          />
        );
      })}
    </div>
  );
}

function MiniCard() {
  return (
    <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-blue-500 bg-blue-50 p-1 text-center dark:bg-blue-950">
      <span className="text-[9px] font-semibold leading-tight">Footman</span>
      <span className="text-lg font-bold leading-none">5</span>
      <span className="text-[7px] leading-tight text-zinc-500 dark:text-zinc-400">+1 in a line</span>
    </div>
  );
}

function InstructionsModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-zinc-300 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">How to play</h2>
          <button
            onClick={onClose}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Close
          </button>
        </div>

        <div className="space-y-5 text-sm">
          <section>
            <h3 className="mb-1 font-semibold">Goal</h3>
            <p className="text-zinc-600 dark:text-zinc-400">
              Place cards on the board to build the highest total score. Cards start face-down and are worth their
              base value plus whatever their effect adds or subtracts — position, ownership, and who's face-up all
              matter. Scores are only revealed at the very end.
            </p>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Your turn</h3>
            <ol className="space-y-2 text-zinc-600 dark:text-zinc-400">
              <li className="flex items-start gap-2">
                <StepBadge n={1} />
                <span>
                  <strong className="text-zinc-800 dark:text-zinc-200">Optionally flip</strong> one face-down card
                  face-up (once flipping unlocks) — at most one per turn, and it's permanent.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <StepBadge n={2} />
                <span>
                  <strong className="text-zinc-800 dark:text-zinc-200">Place one card</strong> from your hand onto a
                  highlighted cell — drag it there, or tap the card then tap the cell.
                </span>
              </li>
            </ol>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">The board</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniBoard />
              <p className="max-w-xs text-zinc-600 dark:text-zinc-400">
                Faint green cells are empty and legal to place on right now — they're not cards, just open targets. A
                placement must be orthogonally adjacent to an existing card or the center tile — nothing goes on the
                center itself, but it always counts as a neighbor.
              </p>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Cards</h3>
            <div className="flex flex-wrap items-center gap-4">
              <MiniCard />
              <ul className="max-w-xs list-disc space-y-1 pl-4 text-zinc-600 dark:text-zinc-400">
                <li>Name and base value, shown in your hand and once revealed.</li>
                <li>A short effect summary — hover any card (hand or board) for the full rules text.</li>
                <li>You can always see your own hand and any face-up card; opponents' face-down cards stay hidden.</li>
              </ul>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Scoring</h3>
            <p className="text-zinc-600 dark:text-zinc-400">
              Nothing is scored during play. When the game ends, every card's final value is computed at once from
              its base value plus its effect — adjacency, ownership, and flip-state all feed in, but never another
              card's already-modified value. Highest total wins; ties share the win.
            </p>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Ending the game</h3>
            <ul className="list-disc space-y-1 pl-4 text-zinc-600 dark:text-zinc-400">
              <li>The board fills up, or</li>
              <li>The round cap is reached, or</li>
              <li>
                Starting from the min-round floor, every round opens a private vote to end — it only ends if a
                majority says yes; ties keep the game going.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Center effects</h3>
            <p className="text-zinc-600 dark:text-zinc-400">
              Each game picks one special rule for the center tile (or none) — shown in the header and on the
              center tile itself. Hover the center tile any time to see what it does.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
