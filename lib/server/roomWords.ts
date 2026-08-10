/**
 * Room codes are a single word from this list, not a random character string --
 * "HYDRA" is far easier to remember, type, and read aloud across a room than "QX7K".
 * Drawn from the game's own card and location names (see lib/content/cards.ts's
 * CARD_DEFS and lib/content/centerEffects.ts's CENTER_EFFECTS) rather than generic
 * nature words -- a room code doubles as a tiny bit of flavor. A one-word card name
 * (hyphens/spaces squashed out, e.g. "Pyre-Bird" -> "pyrebird") is used whole; a
 * multi-word location name instead contributes just its single most distinctive word
 * ("The Pit of Erebus" -> "erebus", "Twin Isles" -> "isles") to keep codes short and
 * a single unambiguous token. Unambiguous to spell, nothing offensive or easily
 * confused with another entry. See rooms.ts's randomRoomCode.
 */
export const ROOM_CODE_WORDS = [
  // Cards (CardDef.name, squashed to one word)
  "warlord",
  "usurper",
  "hydra",
  "pyre",
  "cyclops",
  "zeus",
  "horn",
  "rat",
  "lictor",
  "bear",
  "shield",
  // Card buckets (CardDef.bucket) -- the game's own strategy taxonomy, shown in the catalog.
  "slam",
  "control",
  "engine",
  // Locations (CenterEffectDef.label's single most distinctive word)
  "tree",
  "mirror",
  "dragon",
  "erebus",
  "wyrm",
  "isles",
  "king",
  // A location's other notable word(s), same "individual halves" idea as above.
  "pool",
  "lands",
  "gate",
  "hall",
  "free",
  "court",
  "world",
  "corpse",
];
