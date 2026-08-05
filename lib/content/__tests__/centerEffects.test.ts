import { describe, expect, it } from "vitest";
import { CENTER_EFFECTS, isAvailableAtPlayerCount, randomCenterEffectPool, selectableCenterEffects } from "../centerEffects";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";

describe("isAvailableAtPlayerCount", () => {
  it("is available at every player count when no min/max is set", () => {
    expect(isAvailableAtPlayerCount("threeHeadedDragon", MIN_PLAYERS)).toBe(true);
    expect(isAvailableAtPlayerCount("threeHeadedDragon", MAX_PLAYERS)).toBe(true);
  });

  it("respects minPlayerCount ('only for larger boards')", () => {
    const original = CENTER_EFFECTS.twoTowers.minPlayerCount;
    CENTER_EFFECTS.twoTowers.minPlayerCount = 5;
    expect(isAvailableAtPlayerCount("twoTowers", 4)).toBe(false);
    expect(isAvailableAtPlayerCount("twoTowers", 5)).toBe(true);
    CENTER_EFFECTS.twoTowers.minPlayerCount = original;
  });

  it("respects maxPlayerCount", () => {
    const original = CENTER_EFFECTS.mirrorPool.maxPlayerCount;
    CENTER_EFFECTS.mirrorPool.maxPlayerCount = 3;
    expect(isAvailableAtPlayerCount("mirrorPool", 3)).toBe(true);
    expect(isAvailableAtPlayerCount("mirrorPool", 4)).toBe(false);
    CENTER_EFFECTS.mirrorPool.maxPlayerCount = original;
  });

  it("returns false at every player count when disabled, overriding minPlayerCount/maxPlayerCount", () => {
    const original = { disabled: CENTER_EFFECTS.threeHeadedDragon.disabled, minPlayerCount: CENTER_EFFECTS.threeHeadedDragon.minPlayerCount };
    CENTER_EFFECTS.threeHeadedDragon.disabled = true;
    CENTER_EFFECTS.threeHeadedDragon.minPlayerCount = undefined;
    expect(isAvailableAtPlayerCount("threeHeadedDragon", MIN_PLAYERS)).toBe(false);
    expect(isAvailableAtPlayerCount("threeHeadedDragon", MAX_PLAYERS)).toBe(false);
    CENTER_EFFECTS.threeHeadedDragon.disabled = original.disabled;
    CENTER_EFFECTS.threeHeadedDragon.minPlayerCount = original.minPlayerCount;
  });
});

describe("selectableCenterEffects / randomCenterEffectPool", () => {
  it("excludes an effect restricted to larger boards when below its minPlayerCount", () => {
    const original = CENTER_EFFECTS.kingslayer.minPlayerCount;
    CENTER_EFFECTS.kingslayer.minPlayerCount = 6;
    expect(selectableCenterEffects(2)).not.toContain("kingslayer");
    expect(selectableCenterEffects(6)).toContain("kingslayer");
    expect(randomCenterEffectPool(2)).not.toContain("kingslayer");
    expect(randomCenterEffectPool(6)).toContain("kingslayer");
    CENTER_EFFECTS.kingslayer.minPlayerCount = original;
  });

  it("never includes 'none' in the selectable list, but always includes it in the random pool", () => {
    expect(selectableCenterEffects(2)).not.toContain("none");
    expect(randomCenterEffectPool(2)).toContain("none");
  });

  it("excludes a disabled effect from both lists at every player count", () => {
    const original = CENTER_EFFECTS.reckoning.disabled;
    CENTER_EFFECTS.reckoning.disabled = true;
    expect(selectableCenterEffects(2)).not.toContain("reckoning");
    expect(selectableCenterEffects(8)).not.toContain("reckoning");
    expect(randomCenterEffectPool(2)).not.toContain("reckoning");
    CENTER_EFFECTS.reckoning.disabled = original;
  });
});
