import { FLOORED_AT_ZERO_LABEL } from "@/lib/engine/resolution";

/** A card's own printed floor is rarely worth a breakdown line -- it's not a surprise
 * interaction, just the card's known rule, and is redundant with the Final value
 * already shown. Other contributions stay, since those ARE a surprise interaction with
 * another card or effect worth calling out. */
export function visibleBreakdown(breakdown: { label: string; amount: number }[]) {
  return breakdown.filter((d) => d.label !== FLOORED_AT_ZERO_LABEL);
}

/** Prepends a synthetic "Base" line ahead of the real breakdown. Most cards don't need
 * this -- every listed delta actually lands in Final, so Base is inferable from the
 * card's printed number anyway. But a negated card's breakdown includes an
 * `informational` "Negated by X: -N" line that's deliberately excluded from Final (see
 * resolution.ts), and without an explicit Base anchor that line reads as if it should
 * have lowered Final when it didn't. */
export function breakdownWithBase(breakdown: { label: string; amount: number }[], baseValue: number) {
  return [{ label: "Base", amount: baseValue }, ...visibleBreakdown(breakdown)];
}
