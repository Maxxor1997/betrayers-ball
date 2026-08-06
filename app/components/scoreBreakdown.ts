import { FLOORED_AT_ZERO_LABEL } from "@/lib/engine/resolution";

/** A card's own printed floor is rarely worth a breakdown line -- it's not a surprise
 * interaction, just the card's known rule, and is redundant with the Final value
 * already shown. Other contributions stay, since those ARE a surprise interaction with
 * another card or effect worth calling out. */
export function visibleBreakdown(breakdown: { label: string; amount: number }[]) {
  return breakdown.filter((d) => d.label !== FLOORED_AT_ZERO_LABEL);
}
