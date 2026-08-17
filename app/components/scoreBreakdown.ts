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
