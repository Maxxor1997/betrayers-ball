/**
 * Sliding-window rate limiter, in-memory, per key -- deliberately simple (no Redis, no
 * external store) since this one process is the only place any of this state needs to
 * live, same "in-memory to start" call as RoomRegistry itself. Meant for guarding a
 * small number of expensive or abusable operations (room creation, the analytics
 * endpoint), not a general request-shaping layer.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  /** True (and records the hit) if `key` is still under its limit for this window; false (and does NOT record it) once it's been exceeded. */
  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /**
   * Drops every key with no hits left inside the window -- without this the map would
   * grow forever (one entry per distinct IP ever seen, never removed). Call
   * periodically (see server.ts's own reapIdleRooms interval for the existing
   * pattern) -- not on every `allow()` call, since that would make every request pay
   * for a full sweep.
   */
  prune(now: number = Date.now()): void {
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}
