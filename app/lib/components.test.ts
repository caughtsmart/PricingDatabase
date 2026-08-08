import { describe, expect, it } from "vitest";

import {
  componentsToCostInputs,
  resolveComponents,
  type CostComponentInput,
} from "./components";
import { landedCostOf } from "./margin";

const block = (
  overrides: Partial<CostComponentInput> & Pick<CostComponentInput, "id">,
): CostComponentInput => ({
  parentId: null,
  label: overrides.id,
  kind: "FIXED_PER_UNIT",
  value: 0,
  ...overrides,
});

describe("resolveComponents", () => {
  it("sums fixed blocks and percent blocks separately", () => {
    const resolved = resolveComponents([
      block({ id: "freight", value: 4.5 }),
      block({ id: "packaging", value: 0.5 }),
      block({ id: "duty", kind: "PERCENT_OF_COST", value: 4.5 }),
      block({ id: "fx", kind: "PERCENT_OF_COST", value: 1.2 }),
    ]);

    expect(resolved.extraFixed).toBe(5);
    expect(resolved.extraCostPct).toBeCloseTo(5.7, 6);
    expect(resolved.cyclic).toEqual([]);
  });

  it("a muted block contributes nothing", () => {
    const resolved = resolveComponents([
      block({ id: "freight", value: 4.5, enabled: false }),
      block({ id: "packaging", value: 0.5 }),
    ]);

    expect(resolved.extraFixed).toBe(0.5);
  });

  it("muting a GROUP mutes its whole subtree", () => {
    const resolved = resolveComponents([
      block({ id: "landed", kind: "GROUP", enabled: false }),
      block({ id: "freight", parentId: "landed", value: 4.5 }),
      block({ id: "duty", parentId: "landed", kind: "PERCENT_OF_COST", value: 4.5 }),
      block({ id: "loose", value: 1 }),
    ]);

    expect(resolved.extraFixed).toBe(1);
    expect(resolved.extraCostPct).toBe(0);
  });

  it("a GROUP with enabled children is a container, not a value", () => {
    // The doc's collapse/explode rule: children carry the numbers; the
    // group's own value only counts when it has nothing underneath.
    const resolved = resolveComponents([
      block({ id: "landed", kind: "GROUP", value: 8.4 }),
      block({ id: "freight", parentId: "landed", value: 0.62 }),
    ]);

    expect(resolved.extraFixed).toBe(0.62);
  });

  it("a GROUP with no children collapses to its own value", () => {
    const resolved = resolveComponents([
      block({ id: "landed", kind: "GROUP", value: 8.4 }),
    ]);

    expect(resolved.extraFixed).toBe(8.4);
  });

  it("a GROUP whose children are all muted falls back to its own value", () => {
    // Mute every line of the breakdown and the collapsed figure takes over —
    // the block is "a number or a formula of its children", and with the
    // formula switched off the number is what remains.
    const resolved = resolveComponents([
      block({ id: "landed", kind: "GROUP", value: 8.4 }),
      block({ id: "freight", parentId: "landed", value: 0.62, enabled: false }),
    ]);

    expect(resolved.extraFixed).toBe(8.4);
  });

  it("skips and reports blocks in a parentId cycle rather than hanging", () => {
    const resolved = resolveComponents([
      block({ id: "a", parentId: "b", value: 1 }),
      block({ id: "b", parentId: "a", value: 2 }),
      block({ id: "sane", value: 3 }),
    ]);

    expect(resolved.extraFixed).toBe(3);
    expect(resolved.cyclic.sort()).toEqual(["a", "b"]);
  });

  it("skips orphans whose parent does not exist", () => {
    const resolved = resolveComponents([
      block({ id: "lost", parentId: "ghost", value: 5 }),
      block({ id: "sane", value: 3 }),
    ]);

    expect(resolved.extraFixed).toBe(3);
    expect(resolved.cyclic).toEqual(["lost"]);
  });

  it("routes percent blocks to their declared base", () => {
    const resolved = resolveComponents([
      block({ id: "duty", kind: "PERCENT_OF_COST", value: 4.5 }),
      block({
        id: "royalty",
        kind: "PERCENT_OF_COST",
        base: "NET_REVENUE",
        value: 8,
      }),
      block({
        id: "listing",
        kind: "PERCENT_OF_COST",
        base: "GROSS_PRICE",
        value: 2,
      }),
    ]);

    expect(resolved.extraCostPct).toBe(4.5);
    expect(resolved.extraRevenuePct).toBe(8);
    expect(resolved.extraGrossPct).toBe(2);
  });

  it("an absent base means the goods cost, as it always has", () => {
    const resolved = resolveComponents([
      block({ id: "duty", kind: "PERCENT_OF_COST", value: 4.5 }),
    ]);

    expect(resolved.extraCostPct).toBe(4.5);
    expect(resolved.extraRevenuePct).toBe(0);
    expect(resolved.extraGrossPct).toBe(0);
  });

  it("a muted revenue-based block contributes nothing", () => {
    const resolved = resolveComponents([
      block({
        id: "royalty",
        kind: "PERCENT_OF_COST",
        base: "NET_REVENUE",
        value: 8,
        enabled: false,
      }),
    ]);

    expect(resolved.extraRevenuePct).toBe(0);
  });

  it("treats junk values as zero", () => {
    const resolved = resolveComponents([
      block({ id: "junk", value: Number.NaN }),
      block({ id: "sane", value: 3 }),
    ]);

    expect(resolved.extraFixed).toBe(3);
  });
});

describe("componentsToCostInputs", () => {
  it("feeds the engine the doc's own worked example", () => {
    // MARGIN-MODEL.md §2.2: trade £7.10 + freight £0.62, then duty 4.5% and
    // FX 1.2% on the goods value.
    const inputs = componentsToCostInputs(7.1, [
      block({ id: "freight", value: 0.62 }),
      block({ id: "duty", kind: "PERCENT_OF_COST", value: 4.5 }),
      block({ id: "fx", kind: "PERCENT_OF_COST", value: 1.2 }),
    ]);

    expect(landedCostOf(inputs)).toBeCloseTo((7.1 + 0.62) * 1.057, 4);
  });

  it("keeps a null unit cost null so unknown stays unknown", () => {
    const inputs = componentsToCostInputs(null, [
      block({ id: "freight", value: 0.62 }),
    ]);

    expect(inputs.unitCost).toBeNull();
  });
});
