"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, randomCenterEffectPool } from "@/lib/content/centerEffects";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { ResolutionResult, resolveBoard } from "@/lib/engine/resolution";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, isFlipUnlocked, mustPass } from "@/lib/engine/turns";
import { AiDifficulty, CenterEffectId, GameAction, GameState, Position, posKey } from "@/lib/engine/types";
import { AI_DIFFICULTIES, chooseAiActionForDifficulty, DEFAULT_AI_DIFFICULTY } from "@/lib/ai/difficulty";
import { AI_NAMES, MAX_PLAYERS, MIN_PLAYERS, playerAccentClass, playerDotColorClass } from "@/lib/config/players";
import { NewGameSetup, PendingFlip } from "./types";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { HomeIcon } from "@/app/components/HomeIcon";
import { CardCatalog } from "@/app/components/CardCatalog";
import { InstructionsModal } from "@/app/components/InstructionsModal";
import { LocationTitle } from "@/app/components/LocationTitle";
import { MyStatsModal } from "@/app/components/MyStatsModal";
import { NewGameModal } from "@/app/components/NewGameModal";
import { BoardGrid } from "@/app/components/Board";
import { Hand } from "@/app/components/Hand";
import { visibleBreakdown } from "@/app/components/scoreBreakdown";
import { GameStatusPanel } from "@/app/components/GameStatusPanel";
import { TurnActionChecklist } from "@/app/components/TurnActionChecklist";
import { EndScreen } from "@/app/components/EndScreen";
import { isMobileViewport } from "@/app/hooks/isMobileViewport";
import { useDefaultCollapsed } from "@/app/hooks/useDefaultCollapsed";
import {
  loadHumanCardStats,
  loadHumanPlacementStats,
  saveHumanCardStats,
  saveHumanPlacementStats,
  tallyHumanGame,
} from "@/lib/playtest/humanStats";

const HUMAN = "human";

const DRAG_MIME = "application/x-card-instance-id";

function buildPlayerIds(playerCount: number): string[] {
  return [HUMAN, ...Array.from({ length: playerCount - 1 }, (_, i) => `ai-${i + 1}`)];
}

/**
 * Reads the `players`/`center` query params the home screen's setup popup encodes
 * into its /play link -- lets this page skip showing its own setup prompt when it
 * arrives with a real choice already made. Null (missing or invalid, e.g. a direct
 * param-less visit to /play) falls back to opening the prompt here instead.
 *
 * `center` carries "random" through as-is rather than the home screen pre-resolving
 * it into a concrete location -- otherwise a game launched from the home screen with
 * Random picked would have no way to tell that apart from a deliberately fixed
 * location by the time this page loads, and its first "Play again" would just repeat
 * whatever location got rolled instead of rerolling. `/play` itself resolves it (see
 * the initial state below), the same way its own "New game" popup's confirm does.
 *
 * Takes whatever useSearchParams() returns (not a raw `window.location.search` read)
 * -- that's the router's own live params, guaranteed to reflect the destination URL of
 * a client-side navigation by the time this component's first render runs. A direct
 * `window.location` read landed here first and turned out unreliable for that exact
 * case: the router hasn't necessarily flushed the address bar to the DOM string
 * `window.location.search` exposes at the moment this component's function body
 * executes, so it could see the *previous* page's (param-less) URL and wrongly fall
 * back to the prompt -- a real double-setup bug, not just a theoretical one.
 */
function readGameSetupFromQuery(
  params: { get(name: string): string | null }
): { playerCount: number; centerEffect: CenterEffectId | "random"; aiDifficulty: AiDifficulty } | null {
  const playerCount = Number(params.get("players"));
  const centerEffect = params.get("center");
  const aiDifficultyParam = params.get("difficulty");
  if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) return null;
  if (!centerEffect || (centerEffect !== "random" && !(centerEffect in CENTER_EFFECTS))) return null;
  const aiDifficulty = (aiDifficultyParam && (AI_DIFFICULTIES as string[]).includes(aiDifficultyParam) ? aiDifficultyParam : DEFAULT_AI_DIFFICULTY) as AiDifficulty;
  return { playerCount, centerEffect: centerEffect as CenterEffectId | "random", aiDifficulty };
}

function pickRandomCenterEffect(playerCount: number): CenterEffectId {
  const pool = randomCenterEffectPool(playerCount);
  return pool[Math.floor(Math.random() * pool.length)];
}

function newGameState(playerCount: number, centerEffect: CenterEffectId, aiDifficulty: AiDifficulty): GameState {
  const playerIds = buildPlayerIds(playerCount);
  const aiPlayerIds = playerIds.filter((id) => id !== HUMAN);
  const config = configForPlayerCount(playerCount, centerEffect, aiDifficulty);
  const firstPlayerIndex = Math.floor(Math.random() * playerIds.length);
  return createGame(playerIds, config, undefined, aiPlayerIds, firstPlayerIndex);
}

/** A card's own printed floor is rarely worth a breakdown line -- it's not a surprise
 * interaction, just the card's known rule, and is redundant with the Final value
 * already shown. Other contributions stay, since those ARE a surprise interaction with
 * another card or effect worth calling out. */
function ownerDisplayName(state: GameState, ownerId: string): string {
  if (ownerId === HUMAN) return "You";
  const aiIndex = state.players.filter((p) => p.id !== HUMAN).findIndex((p) => p.id === ownerId);
  return AI_NAMES[aiIndex] ?? `AI ${aiIndex + 1}`;
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

  lines.push("# Betrayer's Ball State", "");
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
        `${CENTER_EFFECTS.championOfTheWeak.label}: the center (value ${endResult.centerAward.value}) went to ${ownerDisplayName(state, endResult.centerAward.ownerId)}.`,
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

  // useSearchParams() (used inside Game, to read the setup the home screen encoded
  // into the URL) requires a Suspense boundary -- Next.js opts the tree using it out
  // of static rendering otherwise. This whole page is already effectively client-only
  // rendered (see the mount gate above), so this never visibly suspends in practice.
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-500">Loading…</div>}>
      <Game />
    </Suspense>
  );
}

function Game() {
  // The router's own live query params (see readGameSetupFromQuery's doc comment for
  // why this has to be useSearchParams() and not a raw window.location read) -- read
  // directly during render, not in an effect, so the very first render already
  // reflects a setup chosen on the home screen, with no flash of the 2p/"none"
  // placeholder beforehand.
  const searchParams = useSearchParams();
  const initialSetup = readGameSetupFromQuery(searchParams);

  const [playerCount, setPlayerCount] = useState(initialSetup?.playerCount ?? 2);
  const [state, setState] = useState<GameState>(() => {
    const playerCount = initialSetup?.playerCount ?? 2;
    const centerEffect =
      initialSetup?.centerEffect === "random" ? pickRandomCenterEffect(playerCount) : (initialSetup?.centerEffect ?? "none");
    return newGameState(playerCount, centerEffect, initialSetup?.aiDifficulty ?? DEFAULT_AI_DIFFICULTY);
  });
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [pendingFlip, setPendingFlip] = useState<PendingFlip | null>(null);
  // Brief flash of TurnActionChecklist's second item as checked right after placing --
  // placing normally ends the turn (and this component's own isHumanTurn) immediately,
  // so without this the player would never actually see it tick before the turn moves
  // on. hadFlipped is snapshotted at place-time (not read live afterward), since
  // state.hasFlippedThisTurn resets for the next player the instant the turn advances.
  const [justPlaced, setJustPlaced] = useState<{ hadFlipped: boolean } | null>(null);
  const justPlacedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (justPlacedTimeoutRef.current) clearTimeout(justPlacedTimeoutRef.current);
  }, []);
  // Player count and center effect are only ever chosen from this setup popup (opened
  // by "New game"), never editable while a game is in progress. Starts open only as a
  // fallback (a direct, param-less visit to /play) -- arriving from the home screen's
  // own setup popup already carries a real choice via the query params above, so there's
  // nothing left to prompt for.
  const [newGameSetup, setNewGameSetup] = useState<NewGameSetup | null>(
    initialSetup ? null : { playerCount: 4, centerEffect: "random", aiDifficulty: DEFAULT_AI_DIFFICULTY }
  );
  // Whether the most recent setup that actually started a game picked "random" rather
  // than a fixed location -- state.config.centerEffect only ever holds the resolved
  // concrete id (random gets rolled into a real CenterEffectId before newGameState is
  // called), so playAgain needs this separately to know whether a rematch should
  // reroll or reuse the same location. Seeded from the query param for a game arrived
  // at via the home screen's link (see readGameSetupFromQuery), so even the very
  // first game's "Play again" reroll behaves correctly, not just ones started from
  // this page's own "New game" popup.
  const [lastCenterEffectWasRandom, setLastCenterEffectWasRandom] = useState(initialSetup?.centerEffect === "random");
  const [showInstructions, setShowInstructions] = useState(false);
  const [showMyStats, setShowMyStats] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [cardsCollapsed, setCardsCollapsed] = useDefaultCollapsed(isMobileViewport());
  // Tally exactly once per game, the moment it reaches "ended" -- reset whenever a new
  // game starts (confirmNewGame/playAgain below), same pattern the playtest page's own
  // self-play tally uses (see PlaySelf.tsx's talliedRef).
  const talliedRef = useRef(false);

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
      const action = chooseAiActionForDifficulty(state, currentPlayerId(state), state.config.aiDifficulty);
      dispatch(action);
    }, 550);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, isAiTurn]);

  // Folds this finished game into the human's own personal stats (see
  // lib/playtest/humanStats.ts) -- separate from the playtest page's bulk AI-sim
  // data, and scoped to just the human's own cards/placement, not every seat's.
  useEffect(() => {
    if (state.phase !== "ended" || talliedRef.current) return;
    talliedRef.current = true;
    const result = resolveBoard(
      state.board,
      state.config.boardBounds,
      state.round,
      state.config.centerEffect,
      state.players.map((p) => p.id)
    );
    const cardStats = loadHumanCardStats();
    const placementStats = loadHumanPlacementStats();
    tallyHumanGame(cardStats, placementStats, result.cards, state.result!.scores, state.config.playerCount, state.round, state.config.centerEffect, HUMAN);
    saveHumanCardStats(cardStats);
    saveHumanPlacementStats(placementStats);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function placeCard(instanceId: string, pos: Position) {
    if (!legalCellKeys.has(posKey(pos))) return;
    const hadFlipped = state.hasFlippedThisTurn;
    dispatch({ type: "place", playerId: HUMAN, instanceId, position: pos });
    setSelectedInstanceId(null);
    setJustPlaced({ hadFlipped });
    if (justPlacedTimeoutRef.current) clearTimeout(justPlacedTimeoutRef.current);
    justPlacedTimeoutRef.current = setTimeout(() => setJustPlaced(null), 600);
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
    setNewGameSetup({ playerCount, centerEffect: "random", aiDifficulty: state.config.aiDifficulty });
  }

  function confirmNewGame() {
    if (!newGameSetup) return;
    const centerEffect: CenterEffectId =
      newGameSetup.centerEffect === "random" ? pickRandomCenterEffect(newGameSetup.playerCount) : newGameSetup.centerEffect;
    setPlayerCount(newGameSetup.playerCount);
    setState(newGameState(newGameSetup.playerCount, centerEffect, newGameSetup.aiDifficulty));
    setSelectedInstanceId(null);
    setPendingFlip(null);
    setNewGameSetup(null);
    setLastCenterEffectWasRandom(newGameSetup.centerEffect === "random");
    talliedRef.current = false;
  }

  /** One-click rematch, same player count and difficulty as the game that just ended -- no setup modal. Rerolls a fresh random location if that's how the last one was picked, otherwise reuses the same fixed one. */
  function playAgain() {
    const centerEffect = lastCenterEffectWasRandom ? pickRandomCenterEffect(playerCount) : state.config.centerEffect;
    setState(newGameState(playerCount, centerEffect, state.config.aiDifficulty));
    setSelectedInstanceId(null);
    setPendingFlip(null);
    talliedRef.current = false;
  }

  function confirmFlip() {
    if (!pendingFlip) return;
    dispatch({ type: "flip", playerId: HUMAN, instanceId: pendingFlip.instanceId });
    setPendingFlip(null);
  }

  const human = state.players.find((p) => p.id === HUMAN)!;
  // "Mine" spans both zones -- a card you own is still yours once it's on the board,
  // not just while it's sitting in your hand.
  const myCardIds = new Set([
    ...human.hand.map((c) => c.cardId),
    ...[...state.board.values()].filter((c) => c.ownerId === HUMAN).map((c) => c.cardId),
  ]);
  // An opponent's card, only once revealed -- never their still-hidden ones, same
  // redaction rule as getVisibleBoard.
  const opponentVisibleBoardCardIds = new Set(
    [...state.board.values()].filter((c) => c.faceUp && c.ownerId !== HUMAN).map((c) => c.cardId)
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
        myCardIds={myCardIds}
        opponentVisibleBoardCardIds={opponentVisibleBoardCardIds}
        currentCenterEffect={state.config.centerEffect}
        myAccentClass={playerAccentClass(state.players, HUMAN)}
        myDotColorClass={playerDotColorClass(state.players, HUMAN)}
        collapsed={cardsCollapsed}
        onCollapsedChange={setCardsCollapsed}
      />
      <div className="flex min-w-0 flex-1 flex-col items-center gap-6">
      <header className="flex w-full max-w-4xl flex-col gap-2">
        <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
          {/* rounded-lg (not the rounded-full pill every action button below uses) --
              a different frame shape, same as ThemeToggle, sets these two apart at a
              glance as utility/nav controls rather than in-game actions. */}
          <Link
            href="/"
            className="justify-self-start flex items-center gap-1 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            <HomeIcon />
            Home
          </Link>
          <div className="justify-self-center text-center">
            <LocationTitle def={CENTER_EFFECTS[state.config.centerEffect]} />
          </div>
          <div className="justify-self-end">
            <ThemeToggle />
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setCardsCollapsed(!cardsCollapsed)}
              className="rounded-full border border-zinc-300 px-2.5 py-0 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-0.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {cardsCollapsed ? "▶" : "◀"} Cards
            </button>
            <button
              onClick={() => setShowInstructions(true)}
              className="rounded-full border border-zinc-300 px-2.5 py-0 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-0.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              How to Play
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setShowMyStats(true)}
              className="rounded-full border border-zinc-300 px-2.5 py-0 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-0.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              My Stats
            </button>
            <button
              onClick={openNewGameSetup}
              className="rounded-full border border-zinc-300 px-2.5 py-0 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-0.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              New Game
            </button>
          </div>
        </div>
      </header>

      {showInstructions && <InstructionsModal onClose={() => setShowInstructions(false)} />}
      {showMyStats && <MyStatsModal onClose={() => setShowMyStats(false)} />}

      {/* Always mounted with a reserved min-height, even when empty -- this area's
          content changes on almost every turn transition (human selects a card, AI's
          turn starts/ends, voting begins), and conditionally mounting/unmounting it
          entirely made the board visibly jump each time as its height came and went.
          Tall enough for the two-line checklist (see TurnActionChecklist) since that's
          the tallest state it ever needs to reserve room for. */}
      <div className="flex min-h-[2.5rem] items-center justify-center text-sm">
        {state.phase === "playing" && (isHumanTurn || justPlaced) ? (
          <TurnActionChecklist
            cardSelected={justPlaced ? false : selectedInstanceId !== null}
            flipUnlocked={flipUnlocked}
            hasFlippedThisTurn={justPlaced ? justPlaced.hadFlipped : state.hasFlippedThisTurn}
            mustPass={justPlaced ? false : humanMustPass}
            placeDone={justPlaced !== null}
          />
        ) : (
          <p>
            {state.phase === "playing"
              ? `${ownerDisplayName(state, currentPlayerId(state))} is thinking…`
              : isVoting && !humanVotePending && "Tallying votes…"}
          </p>
        )}
      </div>

      <BoardGrid
        state={state}
        viewerId={HUMAN}
        nameFor={(id) => ownerDisplayName(state, id)}
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
            ownerAccentClass={playerAccentClass(state.players, HUMAN)}
          />
          {humanMustPass && (
            <button onClick={handlePass} className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black">
              No legal move — Pass
            </button>
          )}
        </div>
      )}

      {state.phase === "ended" && endResult && (
        <EndScreen
          state={state}
          result={endResult}
          viewerId={HUMAN}
          nameFor={(id) => ownerDisplayName(state, id)}
          footer={
            <button
              onClick={playAgain}
              className="shrink-0 rounded-full bg-zinc-900 px-4 py-1.5 text-sm whitespace-nowrap text-white dark:bg-zinc-100 dark:text-black"
            >
              Play again
            </button>
          }
        />
      )}

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
        <NewGameModal setup={newGameSetup} onChange={setNewGameSetup} onCancel={() => setNewGameSetup(null)} onConfirm={confirmNewGame} />
      )}
      </div>
      <GameStatusPanel
        state={state}
        viewerId={HUMAN}
        nameFor={(id) => ownerDisplayName(state, id)}
        flipUnlocked={flipUnlocked}
        onCopyState={copyBoardState}
        copyFeedback={copyFeedback}
      />
    </div>
  );
}

