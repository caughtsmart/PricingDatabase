import { describe, expect, it } from "vitest";

import {
  evaluateAutoSync,
  formatSyncHour,
  syncHourForShop,
  type AutoSyncCandidate,
} from "./autosync";

describe("syncHourForShop", () => {
  it("always returns an hour in range", () => {
    for (let index = 0; index < 500; index += 1) {
      const hour = syncHourForShop(`shop-${index}.myshopify.com`);
      expect(Number.isInteger(hour)).toBe(true);
      expect(hour).toBeGreaterThanOrEqual(0);
      expect(hour).toBeLessThan(24);
    }
  });

  it("is stable across calls", () => {
    // A shop must land on the same hour tomorrow as today, so this must never
    // depend on time, randomness or process state.
    const first = syncHourForShop("orcs-bazaar.myshopify.com");
    const second = syncHourForShop("orcs-bazaar.myshopify.com");
    expect(first).toBe(second);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(syncHourForShop("  Orcs-Bazaar.myshopify.com ")).toBe(
      syncHourForShop("orcs-bazaar.myshopify.com"),
    );
  });

  it("spreads shops across the day rather than clustering", () => {
    // The whole point of hashing is load spreading; if it piled shops onto a
    // few hours we would be no better off than a fixed 03:00 job.
    const counts = new Map<number, number>();
    for (let index = 0; index < 480; index += 1) {
      const hour = syncHourForShop(`store-${index}.myshopify.com`);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }

    expect(counts.size).toBeGreaterThanOrEqual(20);
    // Perfectly even would be 20 per hour; allow generous slack but catch a
    // hash that dumps a quarter of all shops into one slot.
    expect(Math.max(...counts.values())).toBeLessThan(60);
  });
});

describe("evaluateAutoSync", () => {
  const now = new Date("2026-08-06T09:00:00Z");
  const dueShop = "orcs-bazaar.myshopify.com";
  const dueHour = syncHourForShop(dueShop);

  const candidate = (overrides: Partial<AutoSyncCandidate> = {}) => ({
    shop: dueShop,
    autoSyncEnabled: true,
    lastSyncedAt: null,
    hasActiveRun: false,
    ...overrides,
  });

  it("syncs a shop on its assigned hour", () => {
    const decision = evaluateAutoSync(candidate(), dueHour, now);
    expect(decision).toEqual({ shouldSync: true, reason: "due" });
  });

  it("skips a shop on any other hour", () => {
    const otherHour = (dueHour + 1) % 24;
    const decision = evaluateAutoSync(candidate(), otherHour, now);
    expect(decision.shouldSync).toBe(false);
    expect(decision.reason).toBe("not-this-hour");
  });

  it("respects the merchant's opt-out", () => {
    const decision = evaluateAutoSync(
      candidate({ autoSyncEnabled: false }),
      dueHour,
      now,
    );
    expect(decision.shouldSync).toBe(false);
    expect(decision.reason).toBe("disabled");
  });

  it("never starts a second sync alongside a running one", () => {
    const decision = evaluateAutoSync(
      candidate({ hasActiveRun: true }),
      dueHour,
      now,
    );
    expect(decision.shouldSync).toBe(false);
    expect(decision.reason).toBe("already-running");
  });

  it("skips a shop synced within the guard window", () => {
    // Guards against the hourly tick firing twice for the same hour after a
    // retry or a restart.
    const decision = evaluateAutoSync(
      candidate({ lastSyncedAt: new Date("2026-08-06T02:00:00Z") }),
      dueHour,
      now,
    );
    expect(decision.shouldSync).toBe(false);
    expect(decision.reason).toBe("synced-recently");
  });

  it("syncs again once the guard window has passed", () => {
    const decision = evaluateAutoSync(
      candidate({ lastSyncedAt: new Date("2026-08-05T08:00:00Z") }),
      dueHour,
      now,
    );
    expect(decision.shouldSync).toBe(true);
  });

  it("treats the opt-out as decisive even when everything else is due", () => {
    const decision = evaluateAutoSync(
      candidate({ autoSyncEnabled: false, lastSyncedAt: null }),
      dueHour,
      now,
    );
    expect(decision.shouldSync).toBe(false);
  });
});

describe("formatSyncHour", () => {
  it("zero-pads the hour", () => {
    const formatted = formatSyncHour("orcs-bazaar.myshopify.com");
    expect(formatted).toMatch(/^\d{2}:00 UTC$/);
  });
});
