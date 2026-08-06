import { describe, expect, it } from "vitest";
import { PLAYER_COLOR_CLASSES, PLAYER_DOT_COLOR_CLASSES, playerAccentClass, playerDotColorClass } from "../players";

describe("playerAccentClass", () => {
  it("indexes by the player's position in the seat list, not their identity", () => {
    const players = [{ id: "p7" }, { id: "p3" }, { id: "p9" }];
    expect(playerAccentClass(players, "p7")).toBe(PLAYER_COLOR_CLASSES[0]);
    expect(playerAccentClass(players, "p3")).toBe(PLAYER_COLOR_CLASSES[1]);
    expect(playerAccentClass(players, "p9")).toBe(PLAYER_COLOR_CLASSES[2]);
  });

  it("falls back to a neutral class for a playerId not found in the seat list", () => {
    expect(playerAccentClass([{ id: "a" }], "not-seated")).toBe("border-zinc-400 bg-zinc-50 dark:bg-zinc-900");
  });
});

describe("playerDotColorClass", () => {
  it("same index-based lookup as playerAccentClass, from the dot palette", () => {
    const players = [{ id: "a" }, { id: "b" }];
    expect(playerDotColorClass(players, "a")).toBe(PLAYER_DOT_COLOR_CLASSES[0]);
    expect(playerDotColorClass(players, "b")).toBe(PLAYER_DOT_COLOR_CLASSES[1]);
  });

  it("falls back to a neutral dot for a playerId not found in the seat list", () => {
    expect(playerDotColorClass([{ id: "a" }], "not-seated")).toBe("bg-zinc-400");
  });
});
