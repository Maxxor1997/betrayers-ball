import { describe, expect, it } from "vitest";
import { ROOM_CODE_WORDS } from "../roomWords";

describe("ROOM_CODE_WORDS", () => {
  it("has a healthy number of choices, all lowercase letters only, no duplicates", () => {
    expect(ROOM_CODE_WORDS.length).toBeGreaterThan(50);
    expect(new Set(ROOM_CODE_WORDS).size).toBe(ROOM_CODE_WORDS.length);
    for (const word of ROOM_CODE_WORDS) {
      expect(word).toMatch(/^[a-z]+$/);
    }
  });
});
