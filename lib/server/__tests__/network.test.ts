import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLanAddress, getLanOrigin } from "../network";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLanAddress", () => {
  it("picks the first non-internal IPv4 address, not localhost", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
      en0: [{ address: "192.168.1.42", family: "IPv4", internal: false } as os.NetworkInterfaceInfo],
    });
    expect(getLanAddress()).toBe("192.168.1.42");
  });

  it("falls back to localhost when no external interface exists", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
    });
    expect(getLanAddress()).toBe("localhost");
  });
});

describe("getLanOrigin", () => {
  it("picks the first non-internal IPv4 address, not localhost", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
      en0: [{ address: "192.168.1.42", family: "IPv4", internal: false } as os.NetworkInterfaceInfo],
    });
    expect(getLanOrigin(3000)).toBe("http://192.168.1.42:3000");
  });

  it("skips internal and non-IPv4 entries to find the real one", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
      en0: [
        { address: "fe80::1", family: "IPv6", internal: false } as os.NetworkInterfaceInfo,
        { address: "10.0.0.5", family: "IPv4", internal: false } as os.NetworkInterfaceInfo,
      ],
    });
    expect(getLanOrigin(3000)).toBe("http://10.0.0.5:3000");
  });

  it("falls back to localhost when no external interface exists", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
    });
    expect(getLanOrigin(3000)).toBe("http://localhost:3000");
  });
});
