import { CardDef, CardId } from "./types";

/** The 16-card set, per game_spec.md v2. Base values and buckets only — effect logic lives in resolution.ts. */
export const CARD_DEFS: Record<CardId, CardDef> = {
  Footman: { id: "Footman", name: "Footman", base: 5, bucket: "Slam" },
  Giant: { id: "Giant", name: "Giant", base: 6, bucket: "Slam" },
  Warlord: { id: "Warlord", name: "Warlord", base: 8, bucket: "Slam" },
  Exile: { id: "Exile", name: "Exile", base: 9, bucket: "Slam" },
  Pretender: { id: "Pretender", name: "Pretender", base: 7, bucket: "Slam" },
  Berserker: { id: "Berserker", name: "Berserker", base: 3, bucket: "Engine" },
  Commander: { id: "Commander", name: "Commander", base: 2, bucket: "Engine" },
  Champion: { id: "Champion", name: "Champion", base: 4, bucket: "Engine" },
  Darkspawn: { id: "Darkspawn", name: "Darkspawn", base: 2, bucket: "Engine" },
  Chronicler: { id: "Chronicler", name: "Chronicler", base: 2, bucket: "Engine" },
  Earthshaker: { id: "Earthshaker", name: "Earthshaker", base: 3, bucket: "Control" },
  Skysplitter: { id: "Skysplitter", name: "Skysplitter", base: 3, bucket: "Control" },
  Bannerman: { id: "Bannerman", name: "Bannerman", base: 4, bucket: "Control" },
  PlagueBearer: { id: "PlagueBearer", name: "Plague Bearer", base: 3, bucket: "Control" },
  Suppressor: { id: "Suppressor", name: "Suppressor", base: 3, bucket: "Control" },
  Headsman: { id: "Headsman", name: "Headsman", base: 3, bucket: "Control" },
};

export const ALL_CARD_IDS: CardId[] = Object.keys(CARD_DEFS) as CardId[];
