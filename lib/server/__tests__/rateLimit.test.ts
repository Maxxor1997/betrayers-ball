import { describe, expect, it } from "vitest";
import { RateLimiter } from "../rateLimit";

describe("RateLimiter.allow", () => {
  it("allows up to max hits within the window, then rejects the next one", () => {
    const limiter = new RateLimiter(3, 1000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 100)).toBe(true);
    expect(limiter.allow("a", 200)).toBe(true);
    expect(limiter.allow("a", 300)).toBe(false);
  });

  it("tracks each key independently -- one key being throttled doesn't affect another", () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 100)).toBe(false);
    expect(limiter.allow("b", 100)).toBe(true);
  });

  it("is a sliding window -- old hits age out and free up room again", () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 500)).toBe(true);
    expect(limiter.allow("a", 900)).toBe(false); // both prior hits (t=0, t=500) still within 1000ms
    expect(limiter.allow("a", 1001)).toBe(true); // t=0 has now aged out (1001 - 0 >= 1000), only t=500 remains
    expect(limiter.allow("a", 1002)).toBe(false); // t=500 and t=1001 both still within window
  });

  it("a rejected call doesn't itself count as a hit -- the window doesn't fill up just from being asked repeatedly", () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.allow("a", 0)).toBe(true);
    for (let i = 0; i < 5; i++) expect(limiter.allow("a", 100)).toBe(false);
    expect(limiter.allow("a", 1001)).toBe(true); // only the one real hit at t=0 ever existed to age out
  });
});

describe("RateLimiter.prune", () => {
  it("drops a key with no hits left inside the window, freeing it up immediately instead of waiting for its own next allow() call", () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.allow("a", 0);
    expect(limiter.allow("a", 500)).toBe(false); // still within window, still throttled
    limiter.prune(2000); // every hit for "a" is now outside the window
    // Behaviorally unobservable from allow() alone (allow() already re-filters on
    // every call), so this only checks prune() doesn't throw and a fresh hit past
    // the window still succeeds as expected.
    expect(limiter.allow("a", 2001)).toBe(true);
  });

  it("leaves a key with hits still inside the window untouched", () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.allow("a", 0);
    limiter.prune(500); // t=0 is still within the 1000ms window at now=500
    expect(limiter.allow("a", 600)).toBe(false);
  });
});
