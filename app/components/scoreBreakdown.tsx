import { FLOORED_AT_ZERO_LABEL } from "@/lib/engine/resolution";

/** A card's own printed floor is rarely worth a breakdown line -- it's not a surprise
 * interaction, just the card's known rule, and is redundant with the Final value
 * already shown. Other contributions stay, since those ARE a surprise interaction with
 * another card or effect worth calling out. resolution.ts's own breakdown array always
 * starts with a real "Base" entry already (not just for negated cards -- every card,
 * unconditionally), so nothing here needs to add one; a caller that prepends its own
 * synthetic "Base" line on top of this ends up rendering Base twice. */
export interface BreakdownRow {
  label: string;
  amount: number;
  /** See ScoreContribution's own doc comments -- purely display hints, no effect on scoring. */
  crossedOut?: boolean;
  displayAmount?: number;
  /** See ScoreContribution's own doc comment -- still counts toward stats tallies, just never rendered. */
  hidden?: boolean;
}

export function visibleBreakdown(breakdown: BreakdownRow[]) {
  return breakdown.filter((d) => d.label !== FLOORED_AT_ZERO_LABEL && !d.hidden);
}

/**
 * The one score-breakdown popup body, shared by Board.tsx (per-card board tooltip),
 * EndScreen.tsx (post-game table), and GameStatusPanel.tsx's MyScoreTracker (live
 * mid-game estimate) -- previously each of these hand-rolled its own near-identical
 * row list, which had drifted out of sync (different max-widths, different
 * whitespace-nowrap-vs-wrap handling, different "+" sign rules around "Base"). A
 * zero-amount entry (currently only Facestealer/Infiltrator's swap annotation) is
 * rendered as a plain italic caption with no numeric column, rather than as a "+0" row
 * that reads like a real (missing) contribution. A `crossedOut` entry (currently only
 * a negated card's own denied rule) renders the whole row struck through, at its
 * `displayAmount` (falling back to `amount`) rather than the real scoring amount --
 * see ScoreContribution's own doc comments for why those two can differ.
 */
export function BreakdownPopup({ breakdown, finalValue }: { breakdown: BreakdownRow[]; finalValue: number }) {
  return (
    <div className="flex flex-col gap-0.5 text-left">
      {visibleBreakdown(breakdown).map((d, i) => {
        const shown = d.displayAmount ?? d.amount;
        return d.amount === 0 ? (
          <div key={i} className="text-left italic opacity-80">
            {d.label}
          </div>
        ) : (
          <div key={i} className={`flex justify-between gap-3 ${d.crossedOut ? "line-through opacity-60" : ""}`}>
            <span className="break-words">{d.label}</span>
            <span className="shrink-0">
              {shown > 0 && d.label !== "Base" ? "+" : ""}
              {shown}
            </span>
          </div>
        );
      })}
      <div className="mt-0.5 flex justify-between gap-3 border-t border-white/20 pt-0.5 font-semibold dark:border-black/20">
        <span>Final</span>
        <span>{finalValue}</span>
      </div>
    </div>
  );
}
