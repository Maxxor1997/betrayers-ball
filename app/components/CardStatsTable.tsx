"use client";

import { useState } from "react";
import { CARD_DEFS } from "@/lib/content/cards";
import { CardStatsRow } from "@/lib/playtest/cardStats";

export function fmtSigned(n: number | null, decimals = 2): string {
  if (n === null) return "—";
  const s = n.toFixed(decimals);
  return n > 0 ? `+${s}` : s;
}

export type SortDir = 1 | -1;

/** One sort-state hook per table (not one shared across several) -- each table's columns are independent, so sorting one shouldn't touch another's order. */
export function useTableSort<K extends string>(defaultKey: K, defaultDir: SortDir = 1) {
  const [sort, setSort] = useState<{ key: K; dir: SortDir }>({ key: defaultKey, dir: defaultDir });
  const toggle = (key: K) => setSort((prev) => (prev.key === key ? { key, dir: (prev.dir * -1) as SortDir } : { key, dir: 1 }));
  return [sort, toggle] as const;
}

export function sortRows<T>(rows: T[], keyFn: (row: T) => number | string, dir: SortDir): T[] {
  return [...rows].sort((a, b) => {
    const av = keyFn(a);
    const bv = keyFn(b);
    if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
    return ((av as number) - (bv as number)) * dir;
  });
}

/** Clickable column header -- click sorts by this column ascending, click again for descending. Arrow only shown on the currently-active column. */
export function SortTh<K extends string>({
  label,
  sortKey,
  active,
  dir,
  onClick,
  align = "left",
  title,
}: {
  label: string;
  sortKey: K;
  active: boolean;
  dir: SortDir;
  onClick: (key: K) => void;
  align?: "left" | "right";
  title?: string;
}) {
  return (
    <th
      className={`cursor-pointer px-3 py-2 select-none hover:text-zinc-700 dark:hover:text-zinc-300 ${align === "right" ? "text-right" : "text-left"}`}
      onClick={() => onClick(sortKey)}
      title={title}
    >
      <span className={`inline-flex items-center gap-1 whitespace-nowrap ${align === "right" ? "flex-row-reverse" : ""}`}>
        {label}
        <span className={`text-[8px] ${active ? "" : "opacity-0"}`}>{dir === 1 ? "▲" : "▼"}</span>
      </span>
    </th>
  );
}

/**
 * The "By card" table shown in single-player's MyStatsModal, extracted so the
 * multiplayer lobby can show the exact same per-card breakdown (same data source --
 * this browser's own humanStats.ts history, not anything about the current room) --
 * see app/join/[code]/page.tsx and app/host/[code]/page.tsx. Self-contained: renders
 * nothing at all if there's no played-card data yet, heading included, so a caller can
 * drop it in without its own "is there anything to show" check.
 */
export function CardStatsTable({ rows, title = "By card" }: { rows: CardStatsRow[]; title?: string }) {
  const playedCardRows = rows.filter((r) => r.played > 0);
  const [cardSort, toggleCardSort] = useTableSort<"label" | "played" | "delta">("played", -1);
  const cardKeyFns: Record<"label" | "played" | "delta", (r: CardStatsRow) => number | string> = {
    label: (r) => CARD_DEFS[r.cardId].name,
    played: (r) => r.played,
    delta: (r) => r.avgPlacementDelta ?? -Infinity,
  };
  const sortedPlayedCardRows = sortRows(playedCardRows, cardKeyFns[cardSort.key], cardSort.dir);

  if (playedCardRows.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1.5 font-semibold">{title}</h3>
      <div className="w-full overflow-x-auto rounded-lg border border-zinc-300 dark:border-zinc-700">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-300 bg-zinc-50 text-xs text-zinc-500 uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
              <SortTh label="Card" sortKey="label" active={cardSort.key === "label"} dir={cardSort.dir} onClick={toggleCardSort} />
              <SortTh label="Played" sortKey="played" active={cardSort.key === "played"} dir={cardSort.dir} onClick={toggleCardSort} align="right" />
              <SortTh
                label="Placement Δ"
                sortKey="delta"
                active={cardSort.key === "delta"}
                dir={cardSort.dir}
                onClick={toggleCardSort}
                align="right"
                title="Average (your rank - baseline) / (half the game's rank spread), on a fixed -1..+1 scale, when this card's in play -- negative means you tend to place better than a random seat would, positive means worse."
              />
            </tr>
          </thead>
          <tbody>
            {sortedPlayedCardRows.map((row) => (
              <tr key={row.cardId} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                <td className="px-3 py-1.5 font-medium whitespace-nowrap">{CARD_DEFS[row.cardId].name}</td>
                <td className="px-3 py-1.5 text-right">{row.played}</td>
                <td className="px-3 py-1.5 text-right">{fmtSigned(row.avgPlacementDelta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
