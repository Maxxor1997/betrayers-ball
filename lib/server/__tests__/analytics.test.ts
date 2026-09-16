import type { Socket } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIpFromHeaders, clientIpFromSocket, geoFor, logEvent } from "../analytics";

vi.mock("geoip-lite", () => ({
  default: { lookup: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logEvent", () => {
  it("prints one JSON line to stdout with ts, event, and every field merged in", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("room_created", { roomCode: "APPLE", playerCount: 4 });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line).toMatchObject({ event: "room_created", roomCode: "APPLE", playerCount: 4 });
    expect(typeof line.ts).toBe("string");
    expect(new Date(line.ts).toString()).not.toBe("Invalid Date");
  });

  it("works with no fields at all", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("player_joined");
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.event).toBe("player_joined");
  });
});

describe("clientIpFromHeaders", () => {
  it("takes the first entry of a comma-separated X-Forwarded-For string", () => {
    expect(clientIpFromHeaders("203.0.113.5, 10.0.0.1, 10.0.0.2", "10.0.0.99")).toBe("203.0.113.5");
  });

  it("trims whitespace around the first entry", () => {
    expect(clientIpFromHeaders("  203.0.113.5  , 10.0.0.1", undefined)).toBe("203.0.113.5");
  });

  it("takes the first array entry when the header arrives as an array (Node's raw header shape)", () => {
    expect(clientIpFromHeaders(["203.0.113.5", "10.0.0.1"], undefined)).toBe("203.0.113.5");
  });

  it("falls back to the raw remote address when there's no forwarded header at all (direct/local connections)", () => {
    expect(clientIpFromHeaders(undefined, "127.0.0.1")).toBe("127.0.0.1");
  });

  it("falls back to the remote address when the forwarded header is present but empty", () => {
    expect(clientIpFromHeaders("", "127.0.0.1")).toBe("127.0.0.1");
  });

  it("returns undefined when neither is available", () => {
    expect(clientIpFromHeaders(undefined, undefined)).toBeUndefined();
  });
});

describe("clientIpFromSocket", () => {
  function fakeSocket(headers: Record<string, string | string[] | undefined>, address: string): Socket {
    return { handshake: { headers, address } } as unknown as Socket;
  }

  it("prefers X-Forwarded-For over the socket's own (proxy) address", () => {
    const socket = fakeSocket({ "x-forwarded-for": "203.0.113.5" }, "10.0.0.1");
    expect(clientIpFromSocket(socket)).toBe("203.0.113.5");
  });

  it("falls back to the socket's raw address with no proxy header (e.g. local dev)", () => {
    const socket = fakeSocket({}, "127.0.0.1");
    expect(clientIpFromSocket(socket)).toBe("127.0.0.1");
  });
});

describe("geoFor", () => {
  it("returns an empty object for an undefined IP -- no lookup attempted", async () => {
    const geoip = (await import("geoip-lite")).default;
    expect(geoFor(undefined)).toEqual({});
    expect(geoip.lookup).not.toHaveBeenCalled();
  });

  it("returns an empty object when the dataset doesn't recognize the IP", async () => {
    const geoip = (await import("geoip-lite")).default;
    vi.mocked(geoip.lookup).mockReturnValue(null);
    expect(geoFor("203.0.113.5")).toEqual({});
  });

  it("maps a recognized IP to country/region/city", async () => {
    const geoip = (await import("geoip-lite")).default;
    vi.mocked(geoip.lookup).mockReturnValue({
      range: [0, 0],
      country: "US",
      region: "CA",
      eu: "0",
      timezone: "America/Los_Angeles",
      city: "Mountain View",
      ll: [37.386, -122.0838],
      metro: 807,
      area: 1000,
    });
    expect(geoFor("203.0.113.5")).toEqual({ country: "US", region: "CA", city: "Mountain View" });
  });

  it("strips the IPv6-mapped IPv4 prefix before looking up, so a dual-stack listener's addresses still resolve", async () => {
    const geoip = (await import("geoip-lite")).default;
    vi.mocked(geoip.lookup).mockReturnValue(null);
    geoFor("::ffff:203.0.113.5");
    expect(geoip.lookup).toHaveBeenCalledWith("203.0.113.5");
  });
});
