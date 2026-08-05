"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ALL_CARD_IDS, CARD_DEFS, copiesForPlayerCount } from "@/lib/content/cards";
import { inBounds, isOwnerlessPosition } from "@/lib/engine/board";
import {
  CENTER_EFFECTS,
  centerEffectDescription,
  isAvailableAtPlayerCount,
  randomCenterEffectPool,
  selectableCenterEffects,
} from "@/lib/content/centerEffects";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { FLOORED_AT_ZERO_LABEL, ResolutionResult, resolveBoard } from "@/lib/engine/resolution";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, isFlipUnlocked, mustPass } from "@/lib/engine/turns";
import { CardBucket, CardId, CenterEffectId, GameAction, GameState, Position, posKey } from "@/lib/engine/types";
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
  const config = configForPlayerCount(playerCount, centerEffect);
  const firstPlayerIndex = Math.floor(Math.random() * playerIds.length);
  return createGame(playerIds, config, undefined, aiPlayerIds, firstPlayerIndex);
}

/** A card's own printed floor (Warlord/Exile) is rarely worth a breakdown line -- it's
 * not a surprise interaction, just the card's known rule, and is redundant with the
 * Final value already shown. Zeroed-by-Plague-Bearer/Kingslayer stay, since those ARE
 * a surprise interaction with another card worth calling out. */
function visibleBreakdown(breakdown: { label: string; amount: number }[]) {
  return breakdown.filter((d) => d.label !== FLOORED_AT_ZERO_LABEL);
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

/**
 * Dumps the current game state as Markdown for pasting elsewhere (bug reports, asking
 * for help, sharing an interesting board). Respects the same hidden-info rule as the
 * rendered UI -- an opponent's still-face-down card never reveals its identity, even
 * though this is a single-device debug UI, so a copied board matches what you can
 * actually see. Once the game has ended, `endResult` is non-null and its per-card
 * breakdown (see resolution.ts) is included too, same data as the on-screen tooltips.
 */
function buildBoardStateMarkdown(state: GameState, endResult: ResolutionResult | null): string {
  const bounds = state.config.boardBounds;
  const revealAll = state.phase === "ended";
  const lines: string[] = [];

  lines.push("# Board Game State", "");
  lines.push(`- **Round:** ${state.round} / ${state.config.roundCap}`);
  lines.push(`- **Phase:** ${state.phase}`);
  lines.push(`- **Players:** ${state.config.playerCount}`);
  lines.push(`- **Center effect:** ${CENTER_EFFECTS[state.config.centerEffect].label}`);
  lines.push(`- **Board size:** ${bounds.width}×${bounds.height}, center at (${bounds.center.x},${bounds.center.y})`);
  if (state.phase === "playing") lines.push(`- **Current turn:** ${ownerDisplayName(state, currentPlayerId(state))}`);
  lines.push("");

  lines.push("## Board", "", "| Position | Owner | Card | Base | Final |", "|---|---|---|---|---|");
  const placed = [...state.board.entries()]
    .map(([key, card]) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y, card };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const { x, y, card } of placed) {
    const known = revealAll || card.faceUp || card.ownerId === HUMAN;
    const def = known ? CARD_DEFS[card.cardId] : null;
    const cardCell = def ? `${def.name}${card.faceUp || revealAll ? "" : " (face-down)"}` : "🂠 (face-down)";
    const base = def ? String(def.base) : "?";
    const resolved = endResult?.cards.find((c) => c.instanceId === card.instanceId);
    const final = resolved ? String(resolved.finalValue) : "—";
    lines.push(`| (${x},${y}) | ${ownerDisplayName(state, card.ownerId)} | ${cardCell} | ${base} | ${final} |`);
  }
  lines.push("");

  const human = state.players.find((p) => p.id === HUMAN);
  if (human) {
    lines.push("## Your hand", "");
    if (human.hand.length === 0) lines.push("_(empty)_");
    for (const card of human.hand) {
      const def = CARD_DEFS[card.cardId];
      lines.push(`- ${def.name} (${def.base}) — ${def.text}`);
    }
    lines.push("");
  }

  if (revealAll && endResult) {
    const gameResult = state.result!;
    const winnerLabel =
      gameResult.winnerIds.length > 1
        ? "Tie"
        : gameResult.winnerIds[0] === HUMAN
          ? "You"
          : ownerDisplayName(state, gameResult.winnerIds[0]);

    lines.push(`## Result — ${winnerLabel} win${gameResult.winnerIds.length > 1 ? "" : "s"}`, "");
    lines.push("| Player | Score |", "|---|---|");
    for (const p of state.players) lines.push(`| ${ownerDisplayName(state, p.id)} | ${gameResult.scores[p.id]} |`);
    lines.push("");

    if (endResult.centerAward) {
      lines.push(
        `Champion of the Weak: the center (value ${endResult.centerAward.value}) went to ${ownerDisplayName(state, endResult.centerAward.ownerId)}.`,
        ""
      );
    }
    if (endResult.kingslayerHit.length > 0) {
      const hit = endResult.kingslayerHit
        .map((id) => {
          const c = endResult.cards.find((cc) => cc.instanceId === id)!;
          return `${CARD_DEFS[c.cardId].name} (${ownerDisplayName(state, c.ownerId)})`;
        })
        .join(", ");
      lines.push(`Kingslayer hit: ${hit}.`, "");
    }

    const orderIndex = new Map(state.placementOrder.map((id, i) => [id, i]));
    for (const p of state.players) {
      const cards = endResult.cards
        .filter((c) => c.ownerId === p.id)
        .sort((a, b) => (orderIndex.get(a.instanceId) ?? 0) - (orderIndex.get(b.instanceId) ?? 0));
      if (cards.length === 0) continue;
      const votesByRound = new Map(state.voteHistory.filter(({ votes }) => p.id in votes).map(({ round, votes }) => [round, votes[p.id]]));
      lines.push(`### Scoring breakdown — ${ownerDisplayName(state, p.id)} (${gameResult.scores[p.id]})`, "");
      lines.push("| # | Card | Base | Final | Vote | Breakdown |", "|---|---|---|---|---|---|");
      cards.forEach((c, i) => {
        const breakdown = visibleBreakdown(c.breakdown)
          .map((d) => `${d.label} ${d.amount > 0 ? "+" : ""}${d.amount}`)
          .join(", ");
        const vote = votesByRound.get(i + 1);
        const voteText = vote === undefined ? "—" : vote ? "end" : "continue";
        lines.push(`| ${i + 1} | ${CARD_DEFS[c.cardId].name} | ${c.baseValue} | ${c.finalValue} | ${voteText} | ${breakdown} |`);
      });
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
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
  const [copyFeedback, setCopyFeedback] = useState(false);

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

  // Legal placement cells don't depend on whose turn it is (any player could place at
  // any of them) -- computed whenever the game is in "playing" phase so the highlight
  // stays visible while an AI is thinking, not just on the human's turn. Actually
  // clicking/dragging into one is still gated separately by isHumanTurn (see the cell
  // handlers below), so this alone can't let the human act out of turn.
  const legalCells = getLegalPlacementCells(state);
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
  const handCardIds = new Set(human.hand.map((c) => c.cardId));
  // Only cards visible to the human -- face-up (any owner) or face-down but their own
  // -- never an opponent's still-hidden card, same redaction rule as getVisibleBoard.
  const visibleBoardCardIds = new Set(
    [...state.board.values()].filter((c) => c.faceUp || c.ownerId === HUMAN).map((c) => c.cardId)
  );

  // Computed once here (not inside EndScreen) so BoardGrid can also show each card's
  // scoring breakdown on hover, not just the end-of-game summary table.
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

  function copyBoardState() {
    navigator.clipboard.writeText(buildBoardStateMarkdown(state, endResult)).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    });
  }

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-8 lg:flex-row lg:items-start lg:justify-center">
      <CardCatalog
        playerCount={state.config.playerCount}
        handCardIds={handCardIds}
        visibleBoardCardIds={visibleBoardCardIds}
        currentCenterEffect={state.config.centerEffect}
      />
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

      {/* Always mounted with a reserved min-height, even when empty -- this line's
          text changes on almost every turn transition (human selects a card, AI's
          turn starts/ends, voting begins), and conditionally mounting/unmounting the
          element entirely made the board visibly jump each time as its height came
          and went. */}
      <p className="min-h-[1.25rem] text-sm">
        {state.phase === "playing"
          ? isHumanTurn
            ? selectedInstanceId && "Tap a highlighted cell to place the selected card (or just drag it there)."
            : `${ownerDisplayName(state, currentPlayerId(state))} is thinking…`
          : isVoting && !humanVotePending && "Tallying votes…"}
      </p>

      <BoardGrid
        state={state}
        legalCellKeys={legalCellKeys}
        flipTargetIds={flipTargetIds}
        selectedInstanceId={selectedInstanceId}
        dragOverKey={dragOverKey}
        revealAll={state.phase === "ended"}
        resolvedCards={resolvedCards}
        onCellClick={handleBoardCellClick}
        onCellDragOver={handleCellDragOver}
        onCellDragLeave={() => setDragOverKey(null)}
        onCellDrop={handleCellDrop}
      />

      {state.phase === "ended" && (
        <p className="-mt-3 text-xs text-zinc-500">Faded text = was face-down during play</p>
      )}

      {(state.phase === "playing" || state.phase === "voting") && (
        <div className="flex w-full flex-col items-center gap-3">
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

      {state.phase === "ended" && endResult && <EndScreen state={state} result={endResult} />}

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
      <GameStatusPanel
        state={state}
        flipUnlocked={flipUnlocked}
        isHumanTurn={isHumanTurn}
        humanMustPass={humanMustPass}
        onCopyState={copyBoardState}
        copyFeedback={copyFeedback}
      />
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
  resolvedCards,
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
  // a fixed h-20 w-20 -- with wider/taller boards (7-8p can be 11+ columns or rows) a
  // fixed cell size would push the grid past the available width or height. Rows are
  // implicit and auto-sized purely off each cell's own rendered width (aspect-square),
  // so the grid's total footprint is entirely determined by ITS width -- there's no
  // separate row-height constraint to satisfy. That means the whole "fit both
  // dimensions" problem reduces to picking one width, which we compute directly as the
  // smallest of: the available horizontal space (100%), a comfortable 5rem/cell cap,
  // and whatever width keeps the resulting height (at 5rem/cell) within a viewport
  // budget. Setting `width` (not `max-width`) to that precomputed value means there's
  // nothing left for the browser to reflow or overflow -- unlike relying on `aspect-
  // ratio` + `max-height` to shrink an already-definite `width: 100%`, which it won't.
  const CELL_SIZE_PX = 80;
  const GAP_PX = 6;
  const VERTICAL_BUDGET_VH = 90;
  const naturalWidthPx = width * CELL_SIZE_PX + (width - 1) * GAP_PX;
  // `svh` (small viewport height), not `vh` -- `vh` tracks the browser's live visible
  // viewport, which shrinks/grows as mobile browser chrome (address bar) collapses or
  // expands during scrolling/interaction. For a near-square board (8p is ~11x11) this
  // height budget is almost always the binding constraint, so a plain `vh` here meant
  // the board visibly resized mid-game any time the toolbar changed. `svh` always
  // assumes the toolbar is visible (the smallest possible viewport), so it's stable.
  const widthForHeightBudget = `calc(${VERTICAL_BUDGET_VH}svh * ${width / height})`;

  return (
    <div
      className="grid gap-1.5"
      style={{
        gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))`,
        width: `min(100%, ${naturalWidthPx}px, ${widthForHeightBudget})`,
      }}
    >
      {rows.map((y) =>
        cols.map((x) => {
          const pos = { x, y };
          if (!inBounds(pos, state.config.boardBounds)) return null;
          const key = posKey(pos);
          const isOwnerless = isOwnerlessPosition(pos, state.config.boardBounds);
          const card = state.board.get(key);
          const isLegal = legalCellKeys.has(key);

          if (isOwnerless) {
            const effect = CENTER_EFFECTS[state.config.centerEffect];
            const label = effect.ownerlessLabel ?? effect.label;
            const detail = centerEffectDescription(state.config.centerEffect, state.config);
            return (
              <div
                key={key}
                className="relative"
                onMouseEnter={() => setHoveredKey(key)}
                onMouseLeave={() => setHoveredKey((prev) => (prev === key ? null : prev))}
              >
                <div className="flex aspect-square w-full items-center justify-center rounded-md border-2 border-dashed border-zinc-400 p-1 text-center text-[9px] leading-tight break-words text-zinc-400">
                  {label}
                </div>
                {hoveredKey === key && (
                  <div className="pointer-events-none absolute -top-9 left-1/2 z-10 w-max max-w-[14rem] -translate-x-1/2 rounded bg-zinc-900 px-2 py-1 text-center text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black">
                    {label} — {detail}
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
            // Only once the game has ended does a score breakdown exist -- see Game()'s
            // `resolvedCards`, computed once and shared with EndScreen's summary table.
            const resolvedCard = resolvedCards?.get(card.instanceId);
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
                  className={`@container flex aspect-square w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border-2 p-1 text-center ${ownerColorClass(state, card.ownerId)} ${
                    clickable ? "cursor-pointer ring-2 ring-amber-400" : ""
                  }`}
                >
                  {displayFaceUp ? (
                    <>
                      <span
                        className={`w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}
                      >
                        {def.name}
                      </span>
                      <span
                        className={`text-[length:clamp(11px,34cqw,18px)] leading-none font-bold ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}
                      >
                        {def.base}
                      </span>
                    </>
                  ) : (
                    <span className="text-[length:clamp(12px,40cqw,20px)]">🂠</span>
                  )}
                </button>
                {hoveredKey === key && (
                  <div className="pointer-events-none absolute -top-12 left-1/2 z-10 w-max max-w-[12rem] -translate-x-1/2 rounded bg-zinc-900 px-2 py-1 text-center text-white shadow dark:bg-zinc-100 dark:text-black">
                    <div className="text-[10px] font-semibold leading-tight">{tooltipOwner}</div>
                    <div className="text-[10px] leading-tight">{tooltipDetail}</div>
                    {resolvedCard && (
                      <div className="mt-1 border-t border-white/20 pt-1 text-left dark:border-black/20">
                        {visibleBreakdown(resolvedCard.breakdown).map((d, j) => (
                          <div key={j} className="flex justify-between gap-3 text-[10px] whitespace-nowrap">
                            <span>{d.label}</span>
                            <span>
                              {d.amount > 0 ? "+" : ""}
                              {d.amount}
                            </span>
                          </div>
                        ))}
                        <div className="mt-0.5 flex justify-between gap-3 border-t border-white/20 pt-0.5 text-[10px] font-semibold whitespace-nowrap dark:border-black/20">
                          <span>Final</span>
                          <span>{resolvedCard.finalValue}</span>
                        </div>
                      </div>
                    )}
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

/**
 * A tooltip rendered into document.body via a portal, positioned with `fixed` from
 * the anchor's real screen coordinates -- unlike a plain `absolute` tooltip nested
 * inside a scrollable ancestor, this can't get clipped by that ancestor's overflow
 * (CSS forces overflow-x to clip too whenever overflow-y is scrollable, so any
 * tooltip meant to extend sideways out of a vertically-scrolling sidebar needs this).
 */
function FixedTooltip({ rect, children }: { rect: DOMRect; children: React.ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="pointer-events-none fixed z-50 w-max max-w-[14rem] rounded bg-zinc-900 px-2 py-1 text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black"
      style={{ top: rect.top, left: rect.right + 4 }}
    >
      {children}
    </div>,
    document.body
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
  onCopyState,
  copyFeedback,
}: {
  state: GameState;
  flipUnlocked: boolean;
  isHumanTurn: boolean;
  humanMustPass: boolean;
  onCopyState: () => void;
  copyFeedback: boolean;
}) {
  // Flip: label + either a round number (when there's a specific round to wait for)
  // or a text pill (already-resolved states with no single round to point at).
  let flipLabel: string;
  let flipNumber: number | undefined;
  let flipText: string | undefined;
  if (flipUnlocked) {
    flipLabel = "Flip unlocked";
    flipText = "now";
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
          <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">{CENTER_EFFECTS[state.config.centerEffect].label}</span>
          <span className="text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
            {centerEffectDescription(state.config.centerEffect, state.config)}
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
        <div className="h-px w-full shrink-0 bg-zinc-300 dark:bg-zinc-700" />
        <button
          onClick={onCopyState}
          className="w-full rounded-full border border-zinc-300 px-3 py-1.5 text-xs whitespace-nowrap hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {copyFeedback ? "Copied!" : "Copy board state"}
        </button>
      </div>
    </aside>
  );
}

const BUCKET_ORDER: CardBucket[] = ["Slam", "Engine", "Control"];

/** Locations sidebar order, simplest rule to understand first -- not alphabetical or insertion order. */
const LOCATION_COMPLEXITY_ORDER: CenterEffectId[] = [
  "none",
  "twoTowers",
  "threeHeadedDragon",
  "freeCities",
  "reckoning",
  "shadowlands",
  "mirrorPool",
  "championOfTheWeak",
  "kingslayer",
];

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
function CardCatalog({
  playerCount,
  handCardIds,
  visibleBoardCardIds,
  currentCenterEffect,
}: {
  playerCount: number;
  handCardIds: Set<CardId>;
  visibleBoardCardIds: Set<CardId>;
  currentCenterEffect: CenterEffectId;
}) {
  const [hoveredCard, setHoveredCard] = useState<{ id: CardId; rect: DOMRect } | null>(null);
  const [hoveredBucket, setHoveredBucket] = useState<{ bucket: CardBucket; rect: DOMRect } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<CardBucket>>(new Set());
  // Collapsed by default, unlike the card buckets -- center effects are secondary
  // reference info, not something a new player needs open by default.
  const [locationsCollapsed, setLocationsCollapsed] = useState(true);

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
      <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-zinc-500 dark:text-zinc-400">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" /> My Cards
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" /> Cards on Board
        </span>
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
                  onMouseEnter={(e) => setHoveredBucket({ bucket, rect: e.currentTarget.getBoundingClientRect() })}
                  onMouseLeave={() => setHoveredBucket((prev) => (prev?.bucket === bucket ? null : prev))}
                  className="flex w-full items-center gap-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  <span className="inline-block w-3 shrink-0">{bucketCollapsed ? "▶" : "▼"}</span>
                  {bucket}
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-zinc-400 text-[9px] normal-case text-zinc-400 dark:border-zinc-500 dark:text-zinc-500">
                    i
                  </span>
                </button>
                {hoveredBucket?.bucket === bucket && (
                  <FixedTooltip rect={hoveredBucket.rect}>{BUCKET_DESCRIPTIONS[bucket]}</FixedTooltip>
                )}
              </div>
              {!bucketCollapsed && (
                <div className="flex flex-col gap-1.5">
                  {ids.map((id) => {
                    const def = CARD_DEFS[id];
                    const copies = copiesForPlayerCount(def, playerCount);
                    const inHand = handCardIds.has(id);
                    const onBoard = visibleBoardCardIds.has(id);
                    const boxToneClass =
                      copies === 0
                        ? "border-zinc-200 opacity-50 dark:border-zinc-800"
                        : inHand
                          ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                          : onBoard
                            ? "border-emerald-300/70 bg-emerald-50/50 dark:border-emerald-800/70 dark:bg-emerald-950/40"
                            : "border-zinc-300 dark:border-zinc-700";
                    return (
                      <div
                        key={id}
                        className="relative flex min-w-0 items-center gap-2"
                        onMouseEnter={(e) => setHoveredCard({ id, rect: e.currentTarget.getBoundingClientRect() })}
                        onMouseLeave={() => setHoveredCard((prev) => (prev?.id === id ? null : prev))}
                      >
                        <div
                          className={`relative flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 text-center ${boxToneClass}`}
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
                        {hoveredCard?.id === id && <FixedTooltip rect={hoveredCard.rect}>{def.fullText}</FixedTooltip>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        <div>
          <button
            onClick={() => setLocationsCollapsed((prev) => !prev)}
            className="flex w-full items-center gap-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <span className="inline-block w-3 shrink-0">{locationsCollapsed ? "▶" : "▼"}</span>
            Locations
          </button>
          {!locationsCollapsed && (
            <div className="mt-1.5 flex flex-col gap-2">
              {LOCATION_COMPLEXITY_ORDER
                .slice()
                .sort((a, b) => Number(!!CENTER_EFFECTS[a].disabled) - Number(!!CENTER_EFFECTS[b].disabled))
                .map((id) => {
                const def = CENTER_EFFECTS[id];
                const available = isAvailableAtPlayerCount(id, playerCount);
                const isCurrent = id === currentCenterEffect;
                const config = configForPlayerCount(playerCount, id);
                const restriction =
                  def.minPlayerCount && def.maxPlayerCount
                    ? `${def.minPlayerCount}-${def.maxPlayerCount}p only`
                    : def.minPlayerCount
                      ? `${def.minPlayerCount}p+ only`
                      : def.maxPlayerCount
                        ? `up to ${def.maxPlayerCount}p only`
                        : null;
                return (
                  <div
                    key={id}
                    className={`rounded-md border p-1.5 ${
                      isCurrent
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                        : available
                          ? "border-zinc-300 dark:border-zinc-700"
                          : "border-zinc-200 opacity-50 dark:border-zinc-800"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-medium">{def.label}</span>
                      {isCurrent && (
                        <span className="shrink-0 rounded-full bg-blue-500 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                          Current
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-zinc-500 dark:text-zinc-400">{centerEffectDescription(id, config)}</div>
                    {restriction && <div className="mt-0.5 text-[9px] text-zinc-400 dark:text-zinc-500">{restriction}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function Hand({ cards, selectedInstanceId, onCardClick, onCardDragStart, disabled }: HandProps) {
  const sortedCards = [...cards].sort((a, b) => CARD_DEFS[a.cardId].name.localeCompare(CARD_DEFS[b.cardId].name));
  const [hoveredInstanceId, setHoveredInstanceId] = useState<string | null>(null);

  // Cards shrink in width together (flex-basis 7rem down to a 4rem floor) to try to
  // fit one row without wrapping, but height stays fixed rather than tracking width
  // (no aspect-square) so the full name/value/effect text always has room to wrap and
  // show completely instead of truncating as the card narrows. No overflow-x-auto on
  // purpose: setting overflow-x to anything but "visible" forces the browser to also
  // clip overflow-y (a CSS rule, not a bug), which would cut off these cards' hover
  // tooltips.
  return (
    <div className="flex w-full flex-wrap justify-center gap-2 py-1">
      {sortedCards.map((card) => {
        const def = CARD_DEFS[card.cardId];
        const selected = card.instanceId === selectedInstanceId;
        return (
          <div
            key={card.instanceId}
            className="relative"
            style={{ flex: "1 1 7rem", minWidth: "4rem", maxWidth: "7rem" }}
            onMouseEnter={() => setHoveredInstanceId(card.instanceId)}
            onMouseLeave={() => setHoveredInstanceId((prev) => (prev === card.instanceId ? null : prev))}
          >
            <button
              onClick={() => onCardClick(card.instanceId)}
              draggable={!disabled}
              onDragStart={(e) => onCardDragStart(e, card.instanceId)}
              disabled={disabled}
              className={`@container flex h-28 w-full flex-col items-center justify-center gap-1 rounded-md border-2 p-1.5 text-center ${
                disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"
              } ${selected ? "border-amber-500 bg-amber-50 dark:bg-amber-950" : "border-blue-400 dark:border-blue-700"}`}
            >
              <span className="w-full text-[length:clamp(8px,20cqw,10px)] leading-tight break-words font-semibold">{def.name}</span>
              <span className="text-[length:clamp(14px,32cqw,20px)] leading-none font-bold">{def.base}</span>
              <span className="w-full text-[length:clamp(7px,16cqw,9px)] leading-tight break-words text-zinc-500 dark:text-zinc-400">
                {def.text}
              </span>
            </button>
            {hoveredInstanceId === card.instanceId && (
              <div className="pointer-events-none absolute -top-9 left-1/2 z-20 w-max max-w-[12rem] -translate-x-1/2 rounded bg-zinc-900 px-2 py-1 text-center text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black">
                {def.fullText}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PlayerTable({ label, score, colorClass, borderColorClass, cards, extraRow, votesByRound }: PlayerTableProps) {
  const [hoveredInstanceId, setHoveredInstanceId] = useState<string | null>(null);

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
            <th className="py-1 pr-2">Vote</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c, i) => {
            const vote = votesByRound.get(i + 1);
            return (
            <tr key={c.instanceId} className="border-b border-zinc-100 dark:border-zinc-800">
              <td className="py-1 pr-2 text-zinc-500">{i + 1}</td>
              <td
                className="relative py-1 pr-2"
                onMouseEnter={() => setHoveredInstanceId(c.instanceId)}
                onMouseLeave={() => setHoveredInstanceId((prev) => (prev === c.instanceId ? null : prev))}
              >
                <span className="cursor-help underline decoration-zinc-400 decoration-dotted underline-offset-2">
                  {CARD_DEFS[c.cardId].name}
                </span>
                {hoveredInstanceId === c.instanceId && (
                  <div className="pointer-events-none absolute top-full left-0 z-20 mt-1 w-max min-w-[9rem] max-w-[16rem] rounded bg-zinc-900 px-2 py-1.5 text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black">
                    {visibleBreakdown(c.breakdown).map((d, j) => (
                      <div key={j} className="flex justify-between gap-3 whitespace-nowrap">
                        <span>{d.label}</span>
                        <span>
                          {d.amount > 0 ? "+" : ""}
                          {d.amount}
                        </span>
                      </div>
                    ))}
                    <div className="mt-1 flex justify-between gap-3 border-t border-white/20 pt-1 font-semibold whitespace-nowrap dark:border-black/20">
                      <span>Final</span>
                      <span>{c.finalValue}</span>
                    </div>
                  </div>
                )}
              </td>
              <td className="py-1 pr-2">{c.baseValue}</td>
              <td className="py-1 pr-2 font-semibold">{c.finalValue}</td>
              <td className="py-1 pr-2 text-zinc-500">{vote === undefined ? "—" : vote ? "end" : "continue"}</td>
            </tr>
            );
          })}
          {extraRow && (
            <tr className="border-b border-zinc-100 italic dark:border-zinc-800">
              <td className="py-1 pr-2 text-zinc-500">—</td>
              <td className="py-1 pr-2">{extraRow.label}</td>
              <td className="py-1 pr-2">—</td>
              <td className="py-1 pr-2 font-semibold">{extraRow.value}</td>
              <td className="py-1 pr-2">—</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function EndScreen({ state, result }: { state: GameState; result: ResolutionResult }) {
  const gameResult = state.result!;
  const { cards, centerAward, kingslayerHit } = result;

  const orderIndex = new Map(state.placementOrder.map((id, i) => [id, i]));
  const byTurnPlayed = (ownerId: string) =>
    cards
      .filter((c) => c.ownerId === ownerId)
      .sort((a, b) => (orderIndex.get(a.instanceId) ?? 0) - (orderIndex.get(b.instanceId) ?? 0));

  const winnerLabel =
    gameResult.winnerIds.length > 1
      ? "tie!"
      : gameResult.winnerIds[0] === HUMAN
        ? "you win!"
        : `${ownerDisplayName(state, gameResult.winnerIds[0])} wins.`;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-4 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h2 className="text-lg font-semibold">Game over — {winnerLabel}</h2>
      {centerAward && (
        <p className="-mb-2 text-xs text-zinc-500">
          Champion of the Weak: the center (value {centerAward.value}) went to {ownerDisplayName(state, centerAward.ownerId)}.
        </p>
      )}
      {kingslayerHit.length > 0 && (
        <p className="-mb-2 text-xs text-zinc-500">
          Kingslayer hit:{" "}
          {kingslayerHit
            .map((id) => {
              const c = cards.find((cc) => cc.instanceId === id)!;
              return `${CARD_DEFS[c.cardId].name} (${ownerDisplayName(state, c.ownerId)})`;
            })
            .join(", ")}
        </p>
      )}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {state.players.map((p) => (
          <PlayerTable
            key={p.id}
            label={ownerDisplayName(state, p.id)}
            score={gameResult.scores[p.id]}
            colorClass={ownerTextColorClass(state, p.id)}
            borderColorClass={ownerBorderColorClass(state, p.id)}
            cards={byTurnPlayed(p.id)}
            extraRow={centerAward && centerAward.ownerId === p.id ? { label: "Center", value: centerAward.value } : undefined}
            votesByRound={
              new Map(
                state.voteHistory
                  .filter(({ votes }) => p.id in votes)
                  .map(({ round, votes }) => [round, votes[p.id]])
              )
            }
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
