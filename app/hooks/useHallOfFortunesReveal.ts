"use client";

import { useEffect, useRef, useState } from "react";
import { CardInstance, GameState } from "@/lib/engine/types";

const HOF_SPIN_MS = 1100;
const HOF_REVEAL_HOLD_MS = 1400;

/**
 * Hall of Fortunes (reckoning) -- tracks the viewer's own 3-pillar draw flourish:
 * "spinning" for HOF_SPIN_MS once a genuinely fresh offer is drawn for the CURRENT
 * player (see turns.ts's offeredCardsFor/game.ts's redrawOfferForCurrentPlayer -- only
 * the player whose turn it currently is ever has a live offer at all), then "revealed"
 * for HOF_REVEAL_HOLD_MS, then back to "idle". Deliberately only ever fires for the
 * VIEWER's own offer (`activeId === viewerId`) -- an opponent's offer is exactly the
 * hidden information this game is built around never leaking, so their turns never
 * trigger anything here.
 *
 * Called independently from both Board.tsx (drives the Pillar tiles' own spin/reveal
 * animation) and the page-level Hand call site (delays the real Hand from showing/
 * allowing the new offer until this same sequence finishes -- otherwise the cards read
 * as already available while the Pillars are still pretending to draw them). Both
 * callers react to the same `state` prop in the same render, so their independent
 * copies of this state/timers stay in sync without needing to be lifted into one
 * shared owner.
 */
export function useHallOfFortunesReveal(
  state: GameState,
  viewerId: string
): { phase: "idle" | "spinning" | "revealed"; displayCards: CardInstance[] } {
  const [phase, setPhase] = useState<"idle" | "spinning" | "revealed">("idle");
  const [displayCards, setDisplayCards] = useState<CardInstance[]>([]);
  const prevOfferKeyByPlayerRef = useRef<Record<string, string>>({});
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (state.config.centerEffect !== "reckoning") return;
    const activeId = state.players[state.currentPlayerIndex]?.id;
    if (!activeId) return;
    const offer = state.handOffers[activeId] ?? [];
    const offerKey = [...offer]
      .map((c) => c.instanceId)
      .sort()
      .join(",");
    const prevKey = prevOfferKeyByPlayerRef.current[activeId] ?? "";
    prevOfferKeyByPlayerRef.current[activeId] = offerKey;
    if (offerKey === prevKey || offer.length === 0 || activeId !== viewerId) return;

    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    setDisplayCards(offer);
    setPhase("spinning");
    revealTimerRef.current = setTimeout(() => setPhase("revealed"), HOF_SPIN_MS);
    idleTimerRef.current = setTimeout(() => setPhase("idle"), HOF_SPIN_MS + HOF_REVEAL_HOLD_MS);
  }, [state.handOffers, state.currentPlayerIndex, state.players, state.config.centerEffect, viewerId]);

  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  return { phase, displayCards };
}
