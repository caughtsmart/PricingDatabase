import { describe, expect, it } from "vitest";

import { buildWaterfall } from "./waterfall";
import { calculateMargin, type CostRule, type MarginSettings } from "./margin";

const ukSettings: MarginSettings = {
  pricesIncludeTax: true,
  taxRatePct: 20,
  targetMarginPct: 35,
  warnMarginPct: 20,
  criticalMarginPct: 10,
};

const fee: CostRule = {
  id: "fee",
  name: "Payment fee",
  kind: "PERCENT_OF_REVENUE",
  value: 1.75,
  enabled: true,
};

function ukResult(price: number, unitCost: number | null, rules: CostRule[] = []) {
  return calculateMargin({
    price,
    costs: { unitCost },
    rules,
    settings: ukSettings,
  });
}

describe("buildWaterfall", () => {
  it("orders segments as the engine calculates: tax, landed, costs, profit", () => {
    const waterfall = buildWaterfall(ukResult(120, 60, [fee]));

    expect(waterfall.segments.map((segment) => segment.key)).toEqual([
      "tax",
      "landed",
      "fee",
      "profit",
    ]);
  });

  it("shares are fractions of the gross price and account for all of it", () => {
    const waterfall = buildWaterfall(ukResult(120, 60));

    const total = waterfall.segments.reduce(
      (sum, segment) => sum + segment.share,
      0,
    );
    // Tax £20 + landed £60 + profit £40 = the full £120 (2dp rounding slack).
    expect(total).toBeCloseTo(1, 3);

    const landed = waterfall.segments.find((s) => s.key === "landed")!;
    expect(landed.share).toBeCloseTo(0.5, 3);
  });

  it("keeps the profit segment even at exactly zero", () => {
    // £75 inc VAT = £62.50 net against £62.50 cost.
    const waterfall = buildWaterfall(ukResult(75, 62.5));
    const profit = waterfall.segments.find((s) => s.kind === "profit");

    expect(profit).toBeDefined();
    expect(profit!.amount).toBe(0);
  });

  it("marks a loss with a negative share and the critical tone", () => {
    const waterfall = buildWaterfall(ukResult(60, 70));
    const profit = waterfall.segments.find((s) => s.kind === "profit")!;

    expect(waterfall.isLoss).toBe(true);
    expect(profit.label).toBe("Loss");
    expect(profit.amount).toBeLessThan(0);
    expect(profit.share).toBeLessThan(0);
    expect(profit.tone).toBe("critical");
  });

  it("never shows green when no cost is recorded", () => {
    // Missing data must not look like health (DESIGN.md §4). Without a unit
    // cost the raw margin computes at 100%, which classifies "unknown" — the
    // waterfall must not dress that up as success.
    const waterfall = buildWaterfall(ukResult(120, null));
    const profit = waterfall.segments.find((s) => s.kind === "profit")!;

    expect(waterfall.hasCostData).toBe(false);
    expect(profit.tone).not.toBe("success");
  });

  it("drops zero-amount cost segments but keeps their money in the walk", () => {
    const disabled: CostRule = { ...fee, id: "off", enabled: false };
    const waterfall = buildWaterfall(ukResult(120, 60, [disabled]));

    expect(waterfall.segments.some((s) => s.key === "off")).toBe(false);
  });

  it("survives a zero price without NaN", () => {
    const waterfall = buildWaterfall(ukResult(0, 10));

    for (const segment of waterfall.segments) {
      expect(Number.isFinite(segment.share)).toBe(true);
    }
    expect(waterfall.price).toBe(0);
  });

  it("uses warning and critical tones from the engine's own thresholds", () => {
    // 15% margin → warn band under the default thresholds.
    const warn = buildWaterfall(ukResult(120, 85));
    expect(warn.segments.find((s) => s.kind === "profit")!.tone).toBe("warning");

    // 5% margin → critical band.
    const critical = buildWaterfall(ukResult(120, 95));
    expect(critical.segments.find((s) => s.kind === "profit")!.tone).toBe(
      "critical",
    );
  });
});
