"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BoardGrid } from "@/app/components/Board";
import { EndScreen } from "@/app/components/EndScreen";
import { CardArt } from "@/app/components/CardArt";
import { HomeIcon } from "@/app/components/HomeIcon";
import { LocationTitle } from "@/app/components/LocationTitle";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { MAX_PLAYERS, MIN_PLAYERS, playerDotColorClass } from "@/lib/config/players";
import { ALL_CARD_IDS, CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, centerEffectLabel, selectableCenterEffects } from "@/lib/content/centerEffects";
import { configForPlayerCount } from "@/lib/engine/game";
import { resolveBoard } from "@/lib/engine/resolution";
import { Board, CardBucket, CardId, CardInstance, CenterEffectId, GameResult, GameState, PlayerState, Position, posKey } from "@/lib/engine/types";

/** Same order the card catalog groups by -- Slam (aggressive/simple), Engine (build-up), Control (disruptive/situational). */
const BUCKET_ORDER: CardBucket[] = ["Slam", "Engine", "Control"];

/** Every real, placeable card -- "Unknown" is a synthetic placeholder, never a real card (see its own doc comment in types.ts). Disabled cards (currently just Skysplitter) are still included on purpose: this is a testing tool, and previewing a shelved card's animation is exactly the kind of thing it's for. */
const PLACEABLE_CARD_IDS = ALL_CARD_IDS.filter((id) => id !== "Unknown");

/** Drag payload for a palette card being dragged straight onto the board -- see handlePaletteDragStart/handleCellDrop. */
const NEW_CARD_MIME = "application/x-sandbox-new-card";

function playerId(index: number): string {
  return `p${index + 1}`;
}

export default function SandboxPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-500">Loading…</div>;
  }
  return <Sandbox />;
}

function Sandbox() {
  // Open by default everywhere, including mobile -- unlike CardCatalog's own
  // start-collapsed-on-phones default, this palette is the whole point of the page
  // (there's nothing useful to do here without it), so hiding it up front would just
  // be an extra tap for every visitor before they can do anything.
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);

  const [playerCount, setPlayerCount] = useState(4);
  const [centerEffect, setCenterEffect] = useState<CenterEffectId>("none");
  const [viewerIndex, setViewerIndex] = useState(0);
  const [round, setRound] = useState(1);
  const [board, setBoard] = useState<Board>(new Map());
  const [placementOrder, setPlacementOrder] = useState<string[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<CardId | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [removeMode, setRemoveMode] = useState(false);
  const [showScoring, setShowScoring] = useState(false);
  const nextInstanceId = useRef(0);

  const viewerId = playerId(viewerIndex);
  const players: PlayerState[] = useMemo(
    () => Array.from({ length: playerCount }, (_, i) => ({ id: playerId(i), hand: [], isAI: false })),
    [playerCount]
  );
  const nameFor = (id: string) => `Player ${id.slice(1)}`;
  const config = useMemo(() => configForPlayerCount(playerCount, centerEffect, "medium"), [playerCount, centerEffect]);

  // Changing player count or location can change the board's dimensions/ownerless
  // tiles out from under whatever's already placed -- rather than try to carry
  // positions over (some may now be out of bounds or sitting on a new ownerless tile),
  // just clear it. Round/viewer/scoring are unaffected -- those don't touch the board.
  function resetBoard() {
    setBoard(new Map());
    setPlacementOrder([]);
  }

  const resolved = useMemo(
    () => resolveBoard(board, config.boardBounds, round, centerEffect, players.map((p) => p.id)),
    [board, config.boardBounds, round, centerEffect, players]
  );
  const resolvedCardsMap = useMemo(() => new Map(resolved.cards.map((c) => [c.instanceId, c])), [resolved]);
  const gameResult: GameResult = useMemo(() => {
    const scores: Record<string, number> = {};
    for (const p of players) scores[p.id] = resolved.totalsByOwner[p.id] ?? 0;
    const maxScore = players.length > 0 ? Math.max(...players.map((p) => scores[p.id])) : 0;
    const winnerIds = players.filter((p) => scores[p.id] === maxScore).map((p) => p.id);
    return { scores, winnerIds };
  }, [players, resolved]);

  // A synthetic GameState -- never touches the real reducer (applyAction/dispatch),
  // since sandbox mode's whole point is bypassing turn order, hand limits, and
  // one-flip-per-turn rules entirely. Just enough of the real shape for BoardGrid (and
  // EndScreen, once scoring's toggled on) to render off of.
  const state: GameState = {
    config,
    board,
    deck: [],
    players,
    currentPlayerIndex: 0,
    round,
    turnsThisRound: 0,
    passedPlayerIds: new Set(),
    hasFlippedThisTurn: false,
    votes: {},
    voteHistory: [],
    flipHistory: [],
    placementOrder,
    phase: "playing",
    result: showScoring ? gameResult : null,
  };

  function removeCardAt(key: string, instanceId: string) {
    setBoard((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    setPlacementOrder((prev) => prev.filter((id) => id !== instanceId));
  }

  function placeCardAt(key: string, cardId: CardId) {
    const instanceId = `sandbox-${nextInstanceId.current++}`;
    // Same rule a real placement applies (see turns.ts's applyPlace) -- a forceFaceUp
    // card (Cyclops) is always dealt face-up, never playable face-down, and it's what
    // lets its "rising up out of the board" reveal animation trigger correctly (see
    // Board.tsx's flippingIds/risingIds split).
    const faceUp = CARD_DEFS[cardId].forceFaceUp ?? false;
    const newCard: CardInstance = { instanceId, cardId, ownerId: viewerId, faceUp };
    setBoard((prev) => {
      const next = new Map(prev);
      next.set(key, newCard);
      return next;
    });
    setPlacementOrder((prev) => [...prev, instanceId]);
  }

  function handleCellClick(pos: Position) {
    const key = posKey(pos);
    const existing = board.get(key);
    if (existing) {
      if (removeMode) {
        removeCardAt(key, existing.instanceId);
      } else {
        setBoard((prev) => {
          const next = new Map(prev);
          next.set(key, { ...existing, faceUp: !existing.faceUp });
          return next;
        });
      }
    } else if (selectedCardId) {
      placeCardAt(key, selectedCardId);
    }
  }

  // Dragging a card already on the board: tracked in a ref (not just dataTransfer),
  // since dataTransfer.getData() is only reliably readable during "drop"/"dragstart"
  // in most browsers, not "dragover"/"dragend".
  const draggingBoardCard = useRef<{ instanceId: string; key: string } | null>(null);
  // Runs whenever the current drag actually resolves (dropped somewhere, on-board or
  // off) -- set fresh at the start of every board-card drag, cleared once it fires.
  // See handleCardDragStart's own doc comment for why this exists at all.
  const dragResolvedRef = useRef<(() => void) | null>(null);

  function handleCardDragStart(e: React.DragEvent, instanceId: string, pos: Position) {
    const dragging = { instanceId, key: posKey(pos) };
    draggingBoardCard.current = dragging;
    e.dataTransfer.effectAllowed = "move";

    // A drop released outside the board entirely would otherwise be an "invalid"
    // drop as far as the browser's native drag-and-drop is concerned -- most browsers
    // play a snap-back-to-origin animation for the drag image before ever firing
    // dragend, which is what made removal feel delayed. Making the whole document a
    // valid drop target (always calling preventDefault) skips that animation
    // entirely: a board cell's own onCellDrop calls stopPropagation, so this
    // document-level handler only ever actually fires for a drop that truly missed
    // every cell -- exactly "dragged off the board," resolved the instant it's
    // released instead of waiting on dragend.
    const onDocumentDragOver = (ev: DragEvent) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    };
    const onDocumentDrop = (ev: DragEvent) => {
      ev.preventDefault();
      resolve();
      removeCardAt(dragging.key, dragging.instanceId);
    };
    function resolve() {
      document.removeEventListener("dragover", onDocumentDragOver);
      document.removeEventListener("drop", onDocumentDrop);
      draggingBoardCard.current = null;
      dragResolvedRef.current = null;
      setDragOverKey(null);
    }
    dragResolvedRef.current = resolve;
    document.addEventListener("dragover", onDocumentDragOver);
    document.addEventListener("drop", onDocumentDrop);
  }

  function handleCardDragEnd() {
    // Only still set if nothing resolved this drag at all -- neither a board cell nor
    // the document-level catch-all above ever saw a drop (e.g. Escape cancelled it
    // mid-drag). Just cleans up; doesn't remove anything, since nothing was released.
    dragResolvedRef.current?.();
  }

  function handleCellDragOver(e: React.DragEvent, key: string) {
    const isNewCardFromPalette = e.dataTransfer.types.includes(NEW_CARD_MIME);
    if (!draggingBoardCard.current && !isNewCardFromPalette) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isNewCardFromPalette ? "copy" : "move";
    setDragOverKey(key);
  }

  function handleCellDrop(e: React.DragEvent, pos: Position) {
    e.preventDefault();
    // Claims this drop so the document-level off-board catch-all (see
    // handleCardDragStart) never also sees it -- landing on a board cell at all,
    // whether or not the specific move below actually applies, is never "off the
    // board."
    e.stopPropagation();
    setDragOverKey(null);
    const key = posKey(pos);

    const dragging = draggingBoardCard.current;
    if (dragging) {
      dragResolvedRef.current?.();
      if (key !== dragging.key && !board.has(key)) {
        setBoard((prev) => {
          const card = prev.get(dragging.key);
          if (!card) return prev;
          const next = new Map(prev);
          next.delete(dragging.key);
          next.set(key, card);
          return next;
        });
      }
      return;
    }

    const newCardId = e.dataTransfer.getData(NEW_CARD_MIME) as CardId | "";
    if (newCardId && !board.has(key)) placeCardAt(key, newCardId);
  }

  function handlePaletteDragStart(e: React.DragEvent, cardId: CardId) {
    e.dataTransfer.setData(NEW_CARD_MIME, cardId);
    e.dataTransfer.effectAllowed = "copy";
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-8 px-4 py-8 lg:flex-row lg:items-start">
      {!paletteCollapsed && (
        <CardPalette selectedCardId={selectedCardId} onSelect={setSelectedCardId} onDragStartCard={handlePaletteDragStart} />
      )}

      <div className="order-1 mx-auto flex w-full max-w-3xl min-w-0 flex-1 flex-col items-center gap-6 lg:order-2">
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
              <LocationTitle def={CENTER_EFFECTS[centerEffect]} fallback="Sandbox" />
            </div>
            <div className="justify-self-end">
              <ThemeToggle />
            </div>
          </div>
          <div className="flex w-full items-center justify-between gap-2">
            <button
              onClick={() => setPaletteCollapsed(!paletteCollapsed)}
              className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {paletteCollapsed ? "▶" : "◀"} Cards
            </button>
            <p className="flex-1 text-center text-xs text-zinc-500 dark:text-zinc-400">
              Pick a card, then click (or drag) it onto any empty cell. Click a placed card to flip it -- as many
              times as you want, either direction.
            </p>
          </div>
        </header>

        <SandboxControls
          playerCount={playerCount}
          onPlayerCountChange={(n) => {
            setPlayerCount(n);
            resetBoard();
          }}
          centerEffect={centerEffect}
          onCenterEffectChange={(effect) => {
            setCenterEffect(effect);
            resetBoard();
          }}
          round={round}
          onRoundChange={setRound}
          roundCap={config.roundCap}
          viewerIndex={viewerIndex}
          onViewerIndexChange={setViewerIndex}
          players={players}
          removeMode={removeMode}
          onRemoveModeChange={setRemoveMode}
          showScoring={showScoring}
          onShowScoringChange={setShowScoring}
          onClearBoard={resetBoard}
        />

        <BoardGrid
          state={state}
          viewerId={viewerId}
          nameFor={nameFor}
          legalCellKeys={new Set()}
          flipTargetIds={new Set()}
          selectedInstanceId={null}
          dragOverKey={dragOverKey}
          revealAll={showScoring}
          resolvedCards={showScoring ? resolvedCardsMap : undefined}
          forceAllClickable
          onCellClick={handleCellClick}
          onCellDragOver={handleCellDragOver}
          onCellDragLeave={() => setDragOverKey(null)}
          onCellDrop={handleCellDrop}
          onCardDragStart={handleCardDragStart}
          onCardDragEnd={handleCardDragEnd}
        />

        {showScoring && (
          <div className="w-full max-w-2xl">
            <EndScreen state={state} result={resolved} viewerId={viewerId} nameFor={nameFor} />
          </div>
        )}
      </div>
    </div>
  );
}

function SandboxControls({
  playerCount,
  onPlayerCountChange,
  centerEffect,
  onCenterEffectChange,
  round,
  onRoundChange,
  roundCap,
  viewerIndex,
  onViewerIndexChange,
  players,
  removeMode,
  onRemoveModeChange,
  showScoring,
  onShowScoringChange,
  onClearBoard,
}: {
  playerCount: number;
  onPlayerCountChange: (n: number) => void;
  centerEffect: CenterEffectId;
  onCenterEffectChange: (effect: CenterEffectId) => void;
  round: number;
  onRoundChange: (round: number) => void;
  roundCap: number;
  viewerIndex: number;
  onViewerIndexChange: (index: number) => void;
  players: PlayerState[];
  removeMode: boolean;
  onRemoveModeChange: (value: boolean) => void;
  showScoring: boolean;
  onShowScoringChange: (value: boolean) => void;
  onClearBoard: () => void;
}) {
  const controlClass = "rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700";
  const availableLocations = selectableCenterEffects(playerCount);

  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-zinc-300 p-3 dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          Players
          <select
            value={playerCount}
            onChange={(e) => onPlayerCountChange(Number(e.target.value))}
            className={controlClass}
          >
            {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          Location
          <select
            value={centerEffect}
            onChange={(e) => onCenterEffectChange(e.target.value as CenterEffectId)}
            className={controlClass}
          >
            <option value="none">{centerEffectLabel("none")}</option>
            {availableLocations
              .filter((id) => id !== "none")
              .map((id) => (
                <option key={id} value={id}>
                  {centerEffectLabel(id)}
                </option>
              ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          Round
          <select value={round} onChange={(e) => onRoundChange(Number(e.target.value))} className={controlClass}>
            {Array.from({ length: roundCap }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={onClearBoard}
          className="ml-auto rounded-full border border-red-300 px-2.5 py-1 text-xs whitespace-nowrap text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
        >
          Clear board
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          Playing as
          <div className="flex flex-wrap gap-1">
            {players.map((p, i) => (
              <button
                key={p.id}
                onClick={() => onViewerIndexChange(i)}
                title={`Player ${i + 1}`}
                className={`h-5 w-5 rounded-full ${playerDotColorClass(players, p.id)} ${
                  i === viewerIndex ? "ring-2 ring-offset-1 ring-zinc-900 dark:ring-zinc-100 dark:ring-offset-zinc-950" : "opacity-40"
                }`}
              />
            ))}
          </div>
        </div>

        <button
          onClick={() => onRemoveModeChange(!removeMode)}
          className={`rounded-full border px-2.5 py-1 text-xs whitespace-nowrap ${
            removeMode
              ? "border-red-500 bg-red-600 text-white"
              : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          }`}
        >
          {removeMode ? "Remove mode: on" : "Remove mode: off"}
        </button>

        <button
          onClick={() => onShowScoringChange(!showScoring)}
          className={`rounded-full border px-2.5 py-1 text-xs whitespace-nowrap ${
            showScoring
              ? "border-emerald-500 bg-emerald-600 text-white"
              : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          }`}
        >
          {showScoring ? "Scoring: shown" : "Scoring: hidden"}
        </button>
      </div>
    </div>
  );
}

/**
 * Renders nothing at all when collapsed (the parent page conditionally mounts this,
 * same as CardCatalog does -- the toggle button itself lives in the page header, not
 * here). `w-full` (not a fixed width) so it spans the whole phone screen once stacked
 * below the board on mobile -- see the page's own top-level `flex-col lg:flex-row`
 * (which decides "stacked" vs. "beside" in the first place) paired with `order-2
 * lg:order-1` here (and the board column's own matching `order-1 lg:order-2`) so it's
 * the SECOND thing on a narrow phone (scroll down to it under the board) but the
 * FIRST, leftmost thing again once there's room for a real side-by-side layout.
 * `lg:w-64` only kicks in at that same breakpoint, so it stops trying to fill the
 * whole row and squeezing the board down to nothing.
 */
function CardPalette({
  selectedCardId,
  onSelect,
  onDragStartCard,
}: {
  selectedCardId: CardId | null;
  onSelect: (id: CardId | null) => void;
  onDragStartCard: (e: React.DragEvent, id: CardId) => void;
}) {
  return (
    <div className="order-2 w-full shrink-0 lg:order-1 lg:w-64 lg:self-start">
      <div className="mb-2">
        <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Cards</span>
      </div>
      <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto pr-1 lg:max-h-[80vh]">
        {BUCKET_ORDER.map((bucket) => {
          const ids = PLACEABLE_CARD_IDS.filter((id) => CARD_DEFS[id].bucket === bucket).sort((a, b) =>
            CARD_DEFS[a].name.localeCompare(CARD_DEFS[b].name)
          );
          return (
            <div key={bucket}>
              <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{bucket}</h3>
              <div className="grid grid-cols-3 gap-1.5">
                {ids.map((id) => {
                  const def = CARD_DEFS[id];
                  const selected = id === selectedCardId;
                  return (
                    <button
                      key={id}
                      title={def.fullText}
                      onClick={() => onSelect(selected ? null : id)}
                      draggable
                      onDragStart={(e) => onDragStartCard(e, id)}
                      className={`flex flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 text-center ${
                        selected
                          ? "border-amber-500 bg-amber-50 dark:bg-amber-950"
                          : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                      }`}
                    >
                      <span className="w-full truncate text-[9px] leading-tight font-semibold">{def.name}</span>
                      <CardArt cardId={id} className="h-6 w-6 shrink-0" />
                      <span className="text-sm leading-none font-bold">{def.base}</span>
                      {def.disabled && <span className="text-[8px] text-zinc-400">disabled</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
