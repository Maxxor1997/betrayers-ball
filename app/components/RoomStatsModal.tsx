"use client";

import { LobbyState } from "@/lib/server/protocol";

function fmtSigned(n: number, decimals = 2): string {
  const s = n.toFixed(decimals);
  return n > 0 ? `+${s}` : s;
}

function fmtPercent(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * Room-level equivalent of MyStatsModal, deliberately much smaller: no per-card
 * breakdown, no by-location split, no backup/restore -- just "who's actually winning
 * this room" (win rate + normalized placement delta) per seat, accumulated
 * server-side on the GameSession itself (see RoomStatsEntry) across every rematch in
 * this lobby. Sourced straight from `lobby.roomStats`, already pushed to every client
 * on every lobby:update, so this needs no fetch of its own.
 */
export function RoomStatsModal({ lobby, onClose }: { lobby: LobbyState; onClose: () => void }) {
  const nameFor = (playerId: string) => lobby.seats.find((s) => s.playerId === playerId)?.name ?? playerId;
  // Best placement delta (most negative) first -- same "lower is better" convention as MyStatsModal.
  const rows = [...lobby.roomStats].sort((a, b) => a.placementDeltaSum / a.games - b.placementDeltaSum / b.games);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-zinc-300 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Room stats</h2>
          <button
            onClick={onClose}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Close
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500">Finish a game in this room to start tracking stats here.</p>
        ) : (
          <div className="w-full overflow-x-auto rounded-lg border border-zinc-300 dark:border-zinc-700">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-300 bg-zinc-50 text-xs text-zinc-500 uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2 text-right">Games</th>
                  <th className="px-3 py-2 text-right">Win %</th>
                  <th
                    className="px-3 py-2 text-right"
                    title="Average (rank - baseline) / (half the room's rank spread), on a fixed -1..+1 scale -- negative means placing better than a random seat would, positive means worse, 0 is exactly average. Never reset by rematch, only by the room itself ending."
                  >
                    Placement Δ
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.playerId} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                    <td className="px-3 py-1.5 font-medium whitespace-nowrap">{nameFor(row.playerId)}</td>
                    <td className="px-3 py-1.5 text-right">{row.games}</td>
                    <td className="px-3 py-1.5 text-right">{fmtPercent(row.wins / row.games)}</td>
                    <td className="px-3 py-1.5 text-right">{fmtSigned(row.placementDeltaSum / row.games)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
