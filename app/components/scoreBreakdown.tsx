import { FLOORED_AT_ZERO_LABEL } from "@/lib/engine/resolution";

/** A card's own printed floor is rarely worth a breakdown line -- it's not a surprise
 * interaction, just the card's known rule, and is redundant with the Final value
 * already shown. Other contributions stay, since those ARE a surprise interaction with
 * another card or effect worth calling out. resolution.ts's own breakdown array always
 * starts with a real "Base" entry already (not just for negated cards -- every card,
 * unconditionally), so nothing here needs to add one; a caller that prepends its own
 * synthetic "Base" line on top of this ends up rendering Base twice. */
export function visibleBreakdown(breakdown: { label: string; amount: number }[]) {
  return breakdown.filter((d) => d.label !== FLOORED_AT_ZERO_LABEL);
}

/**
 * The one score-breakdown popup body, shared by Board.tsx (per-card board tooltip),
 * EndScreen.tsx (post-game table), and GameStatusPanel.tsx's MyScoreTracker (live
 * mid-game estimate) -- previously each of these hand-rolled its own near-identical
 * row list, which had drifted out of sync (different max-widths, different
 * whitespace-nowrap-vs-wrap handling, different "+" sign rules around "Base"). A
 * zero-amount entry (currently only Facestealer/Infiltrator's swap annotation) is
 * rendered as a plain italic caption with no numeric column, rather than as a "+0" row
 * that reads like a real (missing) contribution.
 */
export function BreakdownPopup({ breakdown, finalValue }: { breakdown: { label: string; amount: number }[]; finalValue: number }) {
  return (
    <div className="flex flex-col gap-0.5 text-left">
      {visibleBreakdown(breakdown).map((d, i) =>
        d.amount === 0 ? (
          <div key={i} className="text-left italic opacity-80">
            {d.label}
          </div>
        ) : (
          <div key={i} className="flex justify-between gap-3">
            <span className="break-words">{d.label}</span>
            <span className="shrink-0">
              {d.amount > 0 && d.label !== "Base" ? "+" : ""}
              {d.amount}
            </span>
          </div>
        )
      )}
      <div className="mt-0.5 flex justify-between gap-3 border-t border-white/20 pt-0.5 font-semibold dark:border-black/20">
        <span>Final</span>
        <span>{finalValue}</span>
      </div>
    </div>
  );
}
