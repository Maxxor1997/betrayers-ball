import { describe, expect, it } from "vitest";
import { getDeviceId } from "../deviceId";

/** Same pattern as lib/playtest/__tests__/store.test.ts -- stubs a minimal `window` for the test's own duration since this environment runs in plain Node with no window at all. */
function withMockWindow<T>(fn: () => T): T {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  (globalThis as { window?: unknown }).window = { localStorage };
  try {
    return fn();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

describe("getDeviceId", () => {
  it("generates and persists an id, reusing the same one on subsequent calls", () => {
    withMockWindow(() => {
      const first = getDeviceId();
      expect(first).toBeTruthy();
      expect(getDeviceId()).toBe(first);
    });
  });

  it("returns an empty string when window is unavailable (SSR), never throws", () => {
    expect(getDeviceId()).toBe("");
  });

  it("falls back to crypto.getRandomValues when crypto.randomUUID isn't exposed -- the exact insecure-context (plain HTTP LAN) failure this exists to survive", () => {
    withMockWindow(() => {
      const realRandomUUID = crypto.randomUUID;
      // @ts-expect-error -- deliberately removing it to simulate an insecure context, same as a phone joining over a plain-HTTP LAN link where this is genuinely undefined.
      delete crypto.randomUUID;
      try {
        const id = getDeviceId();
        // RFC4122 v4 shape: 8-4-4-4-12 hex, version nibble 4, variant nibble 8-b.
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      } finally {
        crypto.randomUUID = realRandomUUID;
      }
    });
  });
});
