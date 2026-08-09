"use client";

import { useState } from "react";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { PLAYER_BORDER_COLOR_CLASSES, PLAYER_TEXT_COLOR_CLASSES } from "@/lib/config/players";
import { ResolutionResult, ResolvedCard } from "@/lib/engine/resolution";
import { GameState } from "@/lib/engine/types";
import { visibleBreakdown } from "./scoreBreakdown";

/** Index-based, not identity-based -- same reasoning as Board.tsx's ownerColorClass. */
function ownerTextColorClass(state: GameState, ownerId: string): string {
  const idx = state.players.findIndex((p) => p.id === ownerId);
  return PLAYER_TEXT_COLOR_CLASSES[idx] ?? "text-zinc-500";
}
function ownerBorderColorClass(state: GameState, ownerId: string): string {
  const idx = state.players.findIndex((p) => p.id === ownerId);
  return PLAYER_BORDER_COLOR_CLASSES[idx] ?? "border-zinc-300 dark:border-zinc-700";
}

/** "1st"/"2nd"/"3rd"/"4th", handling the 11th/12th/13th exception. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function PlayerTable({
  label,
  score,
  placeLabel,
  isYou,
  colorClass,
  borderColorClass,
  cards,
  extraRow,
  votesByRound,
}: {
  label: string;
  score: number;
  /** e.g. "1st place" or "Tied for 2nd place". */
  placeLabel: string;
  /** Visually sets this player's table apart from the rest -- the viewer's own row. */
  isYou: boolean;
  colorClass: string;
  borderColorClass: string;
  cards: ResolvedCard[];
  extraRow?: { label: string; value: number };
  /**
   * This player's vote in round N, keyed by round number -- approximates "the vote
   * taken right after this row's card was placed" by matching the card's row index
   * (1-based) to that round number. Exact when the player placed exactly one card per
   * round with no passes; if they ever passed, later rows drift from their true round.
   */
  votesByRound: Map<number, boolean>;
}) {
  const [hoveredInstanceId, setHoveredInstanceId] = useState<string | null>(null);

  return (
    <div
      className={`min-w-[11rem] flex-1 rounded-md border-l-2 py-2 pr-2 pl-2 ${borderColorClass} ${
        isYou ? "bg-amber-50 ring-2 ring-amber-400 dark:bg-amber-950/30 dark:ring-amber-600" : ""
      }`}
    >
      <h3 className={`mb-1 text-sm font-semibold ${colorClass}`}>
        {label}: {score} <span className="font-normal text-zinc-500 dark:text-zinc-400">— {placeLabel}</span>
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
                <td className="py-1 pr-2 text-zinc-500">{vote === undefined ? "—" : vote ? "end" : "con."}</td>
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

export function EndScreen({
  state,
  result,
  viewerId,
  nameFor,
  footer,
}: {
  state: GameState;
  result: ResolutionResult;
  /** Whose screen this is -- only affects which row gets the "you" highlight/wording. */
  viewerId: string;
  nameFor: (id: string) => string;
  /** Extra content next to the result heading -- e.g. multiplayer's "Play again" button. Single-player passes nothing. */
  footer?: React.ReactNode;
}) {
  const gameResult = state.result!;
  const { cards, centerAward, kingslayerHit } = result;

  const orderIndex = new Map(state.placementOrder.map((id, i) => [id, i]));
  const byTurnPlayed = (ownerId: string) =>
    cards.filter((c) => c.ownerId === ownerId).sort((a, b) => (orderIndex.get(a.instanceId) ?? 0) - (orderIndex.get(b.instanceId) ?? 0));

  const winnerLabel =
    gameResult.winnerIds.length > 1
      ? "tie!"
      : gameResult.winnerIds[0] === viewerId
        ? "you win!"
        : `${nameFor(gameResult.winnerIds[0])} wins.`;

  // Standard competition ranking (1, 2, 2, 4 -- a tie doesn't compress the ranks below
  // it), highest score first. `rankByPlayerId` and `countAtRank` together let each
  // player's row say e.g. "2nd place" or "Tied for 2nd place".
  const rankedPlayerIds = state.players.map((p) => p.id).sort((a, b) => gameResult.scores[b] - gameResult.scores[a]);
  const rankByPlayerId = new Map<string, number>();
  const countAtRank = new Map<number, number>();
  rankedPlayerIds.forEach((id, i) => {
    const rank = i === 0 || gameResult.scores[id] !== gameResult.scores[rankedPlayerIds[i - 1]] ? i + 1 : rankByPlayerId.get(rankedPlayerIds[i - 1])!;
    rankByPlayerId.set(id, rank);
    countAtRank.set(rank, (countAtRank.get(rank) ?? 0) + 1);
  });
  const placeLabel = (id: string): string => {
    const rank = rankByPlayerId.get(id)!;
    const ord = ordinal(rank);
    return (countAtRank.get(rank) ?? 1) > 1 ? `Tied for ${ord} place` : `${ord} place`;
  };

  return (
    <div className="flex w-full max-w-5xl flex-col gap-4 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Game over — {winnerLabel}</h2>
        {footer}
      </div>
      {centerAward && (
        <p className="-mb-2 text-xs text-zinc-500">
          {CENTER_EFFECTS.championOfTheWeak.label}: the center (value {centerAward.value}) went to {nameFor(centerAward.ownerId)}.
        </p>
      )}
      {kingslayerHit.length > 0 && (
        <p className="-mb-2 text-xs text-zinc-500">
          Kingslayer hit:{" "}
          {kingslayerHit
            .map((id) => {
              const c = cards.find((cc) => cc.instanceId === id)!;
              return `${CARD_DEFS[c.cardId].name} (${nameFor(c.ownerId)})`;
            })
            .join(", ")}
        </p>
      )}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {rankedPlayerIds.map((id) => (
          <PlayerTable
            key={id}
            label={nameFor(id)}
            score={gameResult.scores[id]}
            placeLabel={placeLabel(id)}
            isYou={id === viewerId}
            colorClass={ownerTextColorClass(state, id)}
            borderColorClass={ownerBorderColorClass(state, id)}
            cards={byTurnPlayed(id)}
            extraRow={centerAward && centerAward.ownerId === id ? { label: "Center", value: centerAward.value } : undefined}
            votesByRound={new Map(state.voteHistory.filter(({ votes }) => id in votes).map(({ round, votes }) => [round, votes[id]]))}
          />
        ))}
      </div>
    </div>
  );
}
