import { describe, expect, it } from "vitest";

import {
  clampLevel,
  hiddenCostSummary,
  LEVEL_OPTIONS,
  NUDGE_BLOCKS,
  viewForLevel,
  type DisclosureLevel,
} from "./disclosure";

describe("clampLevel", () => {
  it("passes valid levels through", () => {
    expect(clampLevel(1)).toBe(1);
    expect(clampLevel(2)).toBe(2);
    expect(clampLevel(3)).toBe(3);
    expect(clampLevel("3")).toBe(3);
  });

  it("degrades junk to level 1, the simplest view", () => {
    expect(clampLevel(0)).toBe(1);
    expect(clampLevel(4)).toBe(1);
    expect(clampLevel(2.5)).toBe(1);
    expect(clampLevel(null)).toBe(1);
    expect(clampLevel("full")).toBe(1);
    expect(clampLevel(Number.NaN)).toBe(1);
  });
});

describe("viewForLevel", () => {
  it("is monotonic: moving up a level never hides anything", () => {
    // The doc's rule made mechanical — anything visible at level N must be
    // visible at N+1, or "moving up never re-asks" is broken.
    const levels: DisclosureLevel[] = [1, 2, 3];
    for (let i = 0; i < levels.length - 1; i += 1) {
      const lower = viewForLevel(levels[i]);
      const higher = viewForLevel(levels[i + 1]);
      for (const key of Object.keys(lower) as Array<keyof typeof lower>) {
        if (lower[key]) {
          expect(higher[key], `${key} visible at ${levels[i]} but hidden at ${levels[i + 1]}`).toBe(true);
        }
      }
    }
  });

  it("level 1 is a headline, not a workbench", () => {
    const view = viewForLevel(1);
    expect(view.waterfall).toBe(false);
    expect(view.blocks).toBe(false);
    expect(view.solve).toBe(false);
  });

  it("level 2 shows the working but sums shop-wide rules to one line", () => {
    const view = viewForLevel(2);
    expect(view.waterfall).toBe(true);
    expect(view.walk).toBe(true);
    expect(view.itemisedRules).toBe(false);
  });

  it("level 3 shows everything", () => {
    const view = viewForLevel(3);
    for (const value of Object.values(view)) {
      expect(value).toBe(true);
    }
  });
});

describe("hiddenCostSummary", () => {
  it("counts blocks and rules at level 1", () => {
    expect(hiddenCostSummary(1, 2, 3)).toBe(
      "5 costs are folded into the numbers above",
    );
  });

  it("uses singular grammar for one cost", () => {
    expect(hiddenCostSummary(1, 1, 0)).toBe(
      "1 cost is folded into the numbers above",
    );
  });

  it("is silent when nothing is hidden", () => {
    expect(hiddenCostSummary(1, 0, 0)).toBeNull();
    expect(hiddenCostSummary(3, 4, 4)).toBeNull();
  });

  it("at level 2 only counts rules, and only when they are summed", () => {
    // Blocks are individually on screen at level 2; rules fold into one row
    // only when there is more than one of them.
    expect(hiddenCostSummary(2, 5, 1)).toBeNull();
    expect(hiddenCostSummary(2, 5, 2)).toBe(
      "2 costs are folded into the numbers above",
    );
  });
});

describe("catalogue constants", () => {
  it("offers exactly the three documented levels, in order", () => {
    expect(LEVEL_OPTIONS.map((option) => option.level)).toEqual([1, 2, 3]);
  });

  it("nudge blocks use only variant-level kinds and start at no value", () => {
    for (const block of NUDGE_BLOCKS) {
      expect(["FIXED_PER_UNIT", "PERCENT_OF_COST"]).toContain(block.kind);
    }
  });
});
