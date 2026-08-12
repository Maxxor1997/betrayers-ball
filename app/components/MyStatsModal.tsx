"use client";

import { useState } from "react";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { CardStatsRow, PlaytestStats, statsSummary } from "@/lib/playtest/cardStats";
import {
  avgPlacementDelta,
  buildHumanStatsBackup,
  HumanPlacementStats,
  loadHumanCardStats,
  loadHumanPlacementStats,
  OwnPlacementBucket,
  resetHumanCardStats,
  resetHumanPlacementStats,
  restoreHumanStatsBackup,
} from "@/lib/playtest/humanStats";
import { LOCATION_COMPLEXITY_ORDER } from "./CardCatalog";

function fmtSigned(n: number | null, decimals = 2): string {
  if (n === null) return "—";
  const s = n.toFixed(decimals);
  return n > 0 ? `+${s}` : s;
}

type SortDir = 1 | -1;

/** One sort-state hook per table (not one shared across all three) -- each table's columns are independent, so sorting "By card" shouldn't touch "By location"'s order. */
function useTableSort<K extends string>(defaultKey: K, defaultDir: SortDir = 1) {
  const [sort, setSort] = useState<{ key: K; dir: SortDir }>({ key: defaultKey, dir: defaultDir });
  const toggle = (key: K) => setSort((prev) => (prev.key === key ? { key, dir: (prev.dir * -1) as SortDir } : { key, dir: 1 }));
  return [sort, toggle] as const;
}

function sortRows<T>(rows: T[], keyFn: (row: T) => number | string, dir: SortDir): T[] {
  return [...rows].sort((a, b) => {
    const av = keyFn(a);
    const bv = keyFn(b);
    if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
    return ((av as number) - (bv as number)) * dir;
  });
}

/** Clickable column header -- click sorts by this column ascending, click again for descending. Arrow only shown on the currently-active column. */
function SortTh<K extends string>({
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
      <span className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
        {label}
        <span className={`text-[8px] ${active ? "" : "opacity-0"}`}>{dir === 1 ? "▲" : "▼"}</span>
      </span>
    </th>
  );
}

/** Markdown export of everything in the modal -- same "one paste" spirit as the playtest page's own copy button. */
function buildMarkdown(placementStats: HumanPlacementStats, cardRows: CardStatsRow[]): string {
  const lines: string[] = [
    `My stats -- ${placementStats.overall.gamesPlayed} games played`,
    "",
    `Placement Δ: ${fmtSigned(avgPlacementDelta(placementStats.overall))}`,
    "",
  ];

  const playerCounts = Object.keys(placementStats.byPlayerCount)
    .map(Number)
    .sort((a, b) => a - b);
  if (playerCounts.length > 0) {
    lines.push("By player count", "", "| Players | Games | Placement Δ |", "|---|---|---|");
    for (const pc of playerCounts) {
      const bucket = placementStats.byPlayerCount[pc];
      lines.push(`| ${pc}p | ${bucket.gamesPlayed} | ${fmtSigned(avgPlacementDelta(bucket))} |`);
    }
    lines.push("");
  }

  const locations = LOCATION_COMPLEXITY_ORDER.filter((id) => placementStats.byCenterEffect[id]);
  if (locations.length > 0) {
    lines.push("By location", "", "| Location | Games | Placement Δ |", "|---|---|---|");
    for (const id of locations) {
      const bucket = placementStats.byCenterEffect[id];
      lines.push(`| ${CENTER_EFFECTS[id].label} | ${bucket.gamesPlayed} | ${fmtSigned(avgPlacementDelta(bucket))} |`);
    }
    lines.push("");
  }

  const played = cardRows.filter((r) => r.played > 0);
  if (played.length > 0) {
    lines.push("By card", "", "| Card | Played | Placement Δ |", "|---|---|---|");
    for (const row of played) {
      lines.push(`| ${CARD_DEFS[row.cardId].name} | ${row.played} | ${fmtSigned(row.avgPlacementDelta)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function PlacementRow({ label, bucket }: { label: string; bucket: OwnPlacementBucket }) {
  return (
    <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
      <td className="px-3 py-1.5 font-medium whitespace-nowrap">{label}</td>
      <td className="px-3 py-1.5 text-right">{bucket.gamesPlayed}</td>
      <td className="px-3 py-1.5 text-right">{fmtSigned(avgPlacementDelta(bucket))}</td>
    </tr>
  );
}

type PlacementSortKey = "label" | "games" | "delta";
const PLACEMENT_KEY_FNS: Record<PlacementSortKey, (r: { label: string; bucket: OwnPlacementBucket }) => number | string> = {
  label: (r) => r.label,
  games: (r) => r.bucket.gamesPlayed,
  delta: (r) => avgPlacementDelta(r.bucket) ?? -Infinity,
};

export function MyStatsModal({ onClose }: { onClose: () => void }) {
  // Snapshotted once on open, not live-subscribed -- a game finishing while this
  // modal happens to be open (e.g. an AI's turn resolving the game underneath it)
  // just won't be reflected until it's reopened, same one-shot-load spirit as the
  // playtest page's own stats table between runs. Kept as the raw PlaytestStats (not
  // just its derived CardStatsRow[]) so backupStats below has something to serialize.
  const [cardStats, setCardStats] = useState<PlaytestStats>(() => loadHumanCardStats());
  const [placementStats, setPlacementStats] = useState<HumanPlacementStats>(() => loadHumanPlacementStats());
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [backupFeedback, setBackupFeedback] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [restoreText, setRestoreText] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState(false);

  const cardRows = statsSummary(cardStats);
  const playerCounts = Object.keys(placementStats.byPlayerCount)
    .map(Number)
    .sort((a, b) => a - b);
  const locations = LOCATION_COMPLEXITY_ORDER.filter((id) => placementStats.byCenterEffect[id]);
  const playedCardRows = [...cardRows].filter((r) => r.played > 0);

  const [pcSort, togglePcSort] = useTableSort<PlacementSortKey>("label");
  const playerCountRows = sortRows(
    playerCounts.map((pc) => ({ label: `${pc}p`, bucket: placementStats.byPlayerCount[pc] })),
    PLACEMENT_KEY_FNS[pcSort.key],
    pcSort.dir
  );

  const [locSort, toggleLocSort] = useTableSort<PlacementSortKey>("label");
  const locationRows = sortRows(
    locations.map((id) => ({ label: CENTER_EFFECTS[id].label, bucket: placementStats.byCenterEffect[id] })),
    PLACEMENT_KEY_FNS[locSort.key],
    locSort.dir
  );

  const [cardSort, toggleCardSort] = useTableSort<"label" | "played" | "delta">("played", -1);
  const cardKeyFns: Record<"label" | "played" | "delta", (r: CardStatsRow) => number | string> = {
    label: (r) => CARD_DEFS[r.cardId].name,
    played: (r) => r.played,
    delta: (r) => r.avgPlacementDelta ?? -Infinity,
  };
  const sortedPlayedCardRows = sortRows(playedCardRows, cardKeyFns[cardSort.key], cardSort.dir);

  function copyStats() {
    navigator.clipboard.writeText(buildMarkdown(placementStats, cardRows)).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    });
  }

  function backupStats() {
    navigator.clipboard.writeText(buildHumanStatsBackup(cardStats, placementStats)).then(() => {
      setBackupFeedback(true);
      setTimeout(() => setBackupFeedback(false), 1500);
    });
  }

  function submitRestore() {
    if (restoreText === null) return;
    const result = restoreHumanStatsBackup(restoreText);
    if (!result) {
      setRestoreError(true);
      return;
    }
    setCardStats(result.cardStats);
    setPlacementStats(result.placementStats);
    setRestoreText(null);
    setRestoreError(false);
  }

  function clearStats() {
    resetHumanCardStats();
    resetHumanPlacementStats();
    setCardStats(loadHumanCardStats());
    setPlacementStats(loadHumanPlacementStats());
    setConfirmingClear(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-zinc-300 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">My stats</h2>
          <div className="flex flex-wrap items-center gap-2">
            {placementStats.overall.gamesPlayed > 0 && (
              <button
                onClick={copyStats}
                className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                {copyFeedback ? "Copied!" : "Copy"}
              </button>
            )}
            {placementStats.overall.gamesPlayed > 0 && (
              <button
                onClick={backupStats}
                title="Copies a full-precision backup of everything below -- paste it somewhere safe, and Restore it later on any browser/session."
                className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                {backupFeedback ? "Copied!" : "Backup"}
              </button>
            )}
            <button
              onClick={() => {
                setRestoreText(restoreText === null ? "" : null);
                setRestoreError(false);
              }}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Restore
            </button>
            <button
              onClick={onClose}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Close
            </button>
          </div>
        </div>

        {restoreText !== null && (
          <div className="mb-4 flex flex-col gap-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
            <p className="text-xs text-zinc-500">Paste a backup blob (from the Backup button) below, then Load it. This replaces your current stats entirely.</p>
            <textarea
              value={restoreText}
              onChange={(e) => {
                setRestoreText(e.target.value);
                setRestoreError(false);
              }}
              rows={3}
              placeholder="Paste backup here…"
              className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-xs dark:border-zinc-700"
            />
            {restoreError && <p className="text-xs text-red-600 dark:text-red-400">Couldn&rsquo;t read that -- check you copied the whole backup.</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setRestoreText(null);
                  setRestoreError(false);
                }}
                className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={submitRestore}
                disabled={restoreText.trim().length === 0}
                className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
              >
                Load
              </button>
            </div>
          </div>
        )}

        {placementStats.overall.gamesPlayed === 0 ? (
          <p className="text-sm text-zinc-500">Finish a single-player game to start tracking your stats here.</p>
        ) : (
          <div className="space-y-5 text-sm">
            <section>
              <p className="text-zinc-600 dark:text-zinc-400">
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">{placementStats.overall.gamesPlayed}</span> games played --
                placement Δ{" "}
                <span
                  className="font-semibold text-zinc-900 dark:text-zinc-100"
                  title="Average (your rank - baseline) / (half the game's rank spread), on a fixed -1..+1 scale -- negative means you tend to place better than a random seat would, positive means worse, 0 is exactly average, -1/+1 are the best/worst possible finish regardless of player count. Comparable across a mix of player counts, unlike a raw average rank."
                >
                  {fmtSigned(avgPlacementDelta(placementStats.overall))}
                </span>
                .
              </p>
            </section>

            {playerCounts.length > 0 && (
              <section>
                <h3 className="mb-1.5 font-semibold">By player count</h3>
                <div className="w-full overflow-x-auto rounded-lg border border-zinc-300 dark:border-zinc-700">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-300 bg-zinc-50 text-xs text-zinc-500 uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                        <SortTh label="Players" sortKey="label" active={pcSort.key === "label"} dir={pcSort.dir} onClick={togglePcSort} />
                        <SortTh
                          label="Games"
                          sortKey="games"
                          active={pcSort.key === "games"}
                          dir={pcSort.dir}
                          onClick={togglePcSort}
                          align="right"
                        />
                        <SortTh
                          label="Placement Δ"
                          sortKey="delta"
                          active={pcSort.key === "delta"}
                          dir={pcSort.dir}
                          onClick={togglePcSort}
                          align="right"
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {playerCountRows.map((r) => (
                        <PlacementRow key={r.label} label={r.label} bucket={r.bucket} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {locations.length > 0 && (
              <section>
                <h3 className="mb-1.5 font-semibold">By location</h3>
                <div className="w-full overflow-x-auto rounded-lg border border-zinc-300 dark:border-zinc-700">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-300 bg-zinc-50 text-xs text-zinc-500 uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                        <SortTh label="Location" sortKey="label" active={locSort.key === "label"} dir={locSort.dir} onClick={toggleLocSort} />
                        <SortTh
                          label="Games"
                          sortKey="games"
                          active={locSort.key === "games"}
                          dir={locSort.dir}
                          onClick={toggleLocSort}
                          align="right"
                        />
                        <SortTh
                          label="Placement Δ"
                          sortKey="delta"
                          active={locSort.key === "delta"}
                          dir={locSort.dir}
                          onClick={toggleLocSort}
                          align="right"
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {locationRows.map((r) => (
                        <PlacementRow key={r.label} label={r.label} bucket={r.bucket} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {playedCardRows.length > 0 && (
              <section>
                <h3 className="mb-1.5 font-semibold">By card</h3>
                <div className="w-full overflow-x-auto rounded-lg border border-zinc-300 dark:border-zinc-700">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-300 bg-zinc-50 text-xs text-zinc-500 uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                        <SortTh label="Card" sortKey="label" active={cardSort.key === "label"} dir={cardSort.dir} onClick={toggleCardSort} />
                        <SortTh
                          label="Played"
                          sortKey="played"
                          active={cardSort.key === "played"}
                          dir={cardSort.dir}
                          onClick={toggleCardSort}
                          align="right"
                        />
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
            )}

            <section className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
              {confirmingClear ? (
                <>
                  <span className="text-xs text-zinc-500">Clear all of this?</span>
                  <button
                    onClick={() => setConfirmingClear(false)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={clearStats}
                    className="rounded-full border border-red-300 px-3 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    Clear
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmingClear(true)}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Clear my stats
                </button>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
