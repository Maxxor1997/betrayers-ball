import { afterEach, describe, expect, it, vi } from "vitest";
import { track } from "../track";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("track", () => {
  it("POSTs the event and fields as JSON to /api/track", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetchMock);

    track("single_player_started", { playerCount: 4, centerEffect: "none" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/track");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true });
    expect(JSON.parse(init.body)).toEqual({ event: "single_player_started", playerCount: 4, centerEffect: "none" });
  });

  it("never throws even if fetch itself rejects -- a dropped analytics ping should never surface to the caller", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    expect(() => track("single_player_ended")).not.toThrow();
  });
});
