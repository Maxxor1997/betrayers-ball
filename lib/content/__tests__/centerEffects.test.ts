import { describe, expect, it } from "vitest";
import { CENTER_EFFECTS, isAvailableAtPlayerCount, randomCenterEffectPool, selectableCenterEffects } from "../centerEffects";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";

describe("isAvailableAtPlayerCount", () => {
  it("is available at every player count when no min/max is set", () => {
    expect(isAvailableAtPlayerCount("kingslayer", MIN_PLAYERS)).toBe(true);
    expect(isAvailableAtPlayerCount("kingslayer", MAX_PLAYERS)).toBe(true);
  });

  it("respects minPlayerCount ('only for larger boards')", () => {
    const original = CENTER_EFFECTS.noMansLand.minPlayerCount;
    CENTER_EFFECTS.noMansLand.minPlayerCount = 5;
    expect(isAvailableAtPlayerCount("noMansLand", 4)).toBe(false);
    expect(isAvailableAtPlayerCount("noMansLand", 5)).toBe(true);
    CENTER_EFFECTS.noMansLand.minPlayerCount = original;
  });

  it("respects maxPlayerCount", () => {
    const original = CENTER_EFFECTS.mirrorPool.maxPlayerCount;
    CENTER_EFFECTS.mirrorPool.maxPlayerCount = 3;
    expect(isAvailableAtPlayerCount("mirrorPool", 3)).toBe(true);
    expect(isAvailableAtPlayerCount("mirrorPool", 4)).toBe(false);
    CENTER_EFFECTS.mirrorPool.maxPlayerCount = original;
  });

  it("returns false at every player count when disabled, overriding minPlayerCount/maxPlayerCount", () => {
    const original = { disabled: CENTER_EFFECTS.pryingEyes.disabled, minPlayerCount: CENTER_EFFECTS.pryingEyes.minPlayerCount };
    CENTER_EFFECTS.pryingEyes.disabled = true;
    CENTER_EFFECTS.pryingEyes.minPlayerCount = undefined;
    expect(isAvailableAtPlayerCount("pryingEyes", MIN_PLAYERS)).toBe(false);
    expect(isAvailableAtPlayerCount("pryingEyes", MAX_PLAYERS)).toBe(false);
    CENTER_EFFECTS.pryingEyes.disabled = original.disabled;
    CENTER_EFFECTS.pryingEyes.minPlayerCount = original.minPlayerCount;
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
