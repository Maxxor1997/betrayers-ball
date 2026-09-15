import { CardId } from "@/lib/engine/types";

/**
 * One distinct flip sound per card, picked for thematic fit rather than a single
 * generic "flip" noise reused everywhere -- see the /sounds/cards README for the
 * full reasoning behind each pick. Keyed by CardId (the internal id, e.g. "Footman"
 * for Hoplite) since that's what a CardInstance actually carries; Unknown has no
 * sound (never a real playable card -- see its own doc comment in cards.ts).
 */
export const CARD_FLIP_SOUNDS: Partial<Record<CardId, string>> = {
  DyingGod: "/sounds/cards/DyingGod.mp3",
  Exile: "/sounds/cards/Exile.mp3",
  Warlord: "/sounds/cards/Warlord.mp3",
  Pretender: "/sounds/cards/Pretender.mp3",
  Giant: "/sounds/cards/Giant.mp3",
  Footman: "/sounds/cards/Footman.mp3",
  Berserker: "/sounds/cards/Berserker.mp3",
  Commander: "/sounds/cards/Commander.mp3",
  Gloryseeker: "/sounds/cards/Gloryseeker.mp3",
  Skysplitter: "/sounds/cards/Skysplitter.mp3",
  Bannerman: "/sounds/cards/Bannerman.mp3",
  Mercenary: "/sounds/cards/Mercenary.mp3",
  Beacon: "/sounds/cards/Beacon.mp3",
  Chronicler: "/sounds/cards/Chronicler.mp3",
  Earthshaker: "/sounds/cards/Earthshaker.mp3",
  PlagueBearer: "/sounds/cards/PlagueBearer.mp3",
  Suppressor: "/sounds/cards/Suppressor.mp3",
  Infiltrator: "/sounds/cards/Infiltrator.mp3",
  Truthseeker: "/sounds/cards/Truthseeker.mp3",
  PlagueRat: "/sounds/cards/PlagueRat.mp3",
};

/** Non-card-specific one-shots -- placement, voting, and the round-end reveal. */
export const SOUNDS = {
  place: "/sounds/place.mp3",
  vote: "/sounds/vote.mp3",
  roundFlip: "/sounds/round-flip.mp3",
  gameOver: "/sounds/game-over.mp3",
};
