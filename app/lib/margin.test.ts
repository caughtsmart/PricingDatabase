import { describe, expect, it } from "vitest";

import {
  aggregate,
  calculateMargin,
  roundMoney,
  solvePriceForMargin,
  toNetRevenue,
  type CostRule,
  type MarginSettings,
} from "./margin";

const ukSettings: MarginSettings = {
  pricesIncludeTax: true,
  taxRatePct: 20,
  targetMarginPct: 35,
  warnMarginPct: 20,
  criticalMarginPct: 10,
};

const usSettings: MarginSettings = {
  ...ukSettings,
  pricesIncludeTax: false,
  taxRatePct: 0,
};

const noRules: CostRule[] = [];

const paymentFee: CostRule = {
  id: "fee",
  name: "Payment fee",
  kind: "PERCENT_OF_REVENUE",
  value: 1.75,
  enabled: true,
};

const pickPack: CostRule = {
  id: "pick",
  name: "Pick & pack",
  kind: "FIXED_PER_UNIT",
  value: 0.45,
  enabled: true,
};

describe("roundMoney", () => {
  it("rounds half away from zero despite float representation", () => {
    expect(roundMoney(8.325)).toBe(8.33);
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(-8.325)).toBe(-8.33);
  });

  it("survives non-finite input rather than propagating NaN", () => {
    expect(roundMoney(NaN)).toBe(0);
    expect(roundMoney(Infinity)).toBe(0);
  });
});

describe("toNetRevenue", () => {
  it("strips VAT from tax-inclusive prices", () => {
    expect(roundMoney(toNetRevenue(120, ukSettings))).toBe(100);
  });

  it("leaves tax-exclusive prices untouched", () => {
    expect(toNetRevenue(120, usSettings)).toBe(120);
  });
});

describe("calculateMargin", () => {
  it("computes a plain gross margin with no extras and no tax", () => {
    const result = calculateMargin({
      price: 100,
      costs: { unitCost: 60 },
      rules: noRules,
      settings: usSettings,
    });

    expect(result.netRevenue).toBe(100);
    expect(result.landedUnitCost).toBe(60);
    expect(result.grossProfit).toBe(40);
    expect(result.netProfit).toBe(40);
    expect(result.netMarginPct).toBe(40);
    expect(result.status).toBe("healthy");
    expect(result.hasCostData).toBe(true);
  });

  it("removes VAT before computing margin on a UK tax-inclusive price", () => {
    // £120 inc VAT is £100 of revenue. Against a £60 cost that is 40%, not the
    // 50% a naive (price - cost) / price calculation would report.
    const result = calculateMargin({
      price: 120,
      costs: { unitCost: 60 },
      rules: noRules,
      settings: ukSettings,
    });

    expect(result.netRevenue).toBe(100);
    expect(result.taxAmount).toBe(20);
    expect(result.netMarginPct).toBe(40);
  });

  it("folds per-variant extras into landed cost", () => {
    const result = calculateMargin({
      price: 120,
      costs: {
        unitCost: 60,
        freight: 5,
        duty: 2.5,
        packaging: 1,
        handling: 0.5,
        other: 1,
      },
      rules: noRules,
      settings: ukSettings,
    });

    expect(result.extraUnitCost).toBe(10);
    expect(result.landedUnitCost).toBe(70);
    expect(result.grossProfit).toBe(30);
    expect(result.netMarginPct).toBe(30);
  });

  it("applies percentage and fixed shop-wide rules", () => {
    const result = calculateMargin({
      price: 120,
      costs: { unitCost: 60 },
      rules: [paymentFee, pickPack],
      settings: ukSettings,
    });

    // Net revenue £100 -> 1.75% = £1.75, plus £0.45 flat.
    expect(result.totalVariableCost).toBe(2.2);
    expect(result.totalCost).toBe(62.2);
    expect(result.netProfit).toBe(37.8);
    expect(result.netMarginPct).toBe(37.8);
    // Gross profit deliberately ignores shop-wide rules.
    expect(result.grossProfit).toBe(40);
  });

  it("ignores disabled rules", () => {
    const result = calculateMargin({
      price: 120,
      costs: { unitCost: 60 },
      rules: [{ ...paymentFee, enabled: false }],
      settings: ukSettings,
    });

    expect(result.appliedCosts).toHaveLength(0);
    expect(result.totalVariableCost).toBe(0);
  });

  it("flags a variant sold below total cost as a loss", () => {
    const result = calculateMargin({
      price: 60,
      costs: { unitCost: 60 },
      rules: [paymentFee],
      settings: ukSettings,
    });

    expect(result.netProfit).toBeLessThan(0);
    expect(result.status).toBe("loss");
  });

  it("grades margins against the warn and critical thresholds", () => {
    const at5 = calculateMargin({
      price: 120,
      costs: { unitCost: 95 },
      rules: noRules,
      settings: ukSettings,
    });
    expect(at5.netMarginPct).toBe(5);
    expect(at5.status).toBe("critical");

    const at15 = calculateMargin({
      price: 120,
      costs: { unitCost: 85 },
      rules: noRules,
      settings: ukSettings,
    });
    expect(at15.netMarginPct).toBe(15);
    expect(at15.status).toBe("warn");
  });

  it("reports unknown status when no unit cost is recorded", () => {
    const result = calculateMargin({
      price: 120,
      costs: { unitCost: null },
      rules: noRules,
      settings: ukSettings,
    });

    expect(result.hasCostData).toBe(false);
    expect(result.status).toBe("unknown");
    // Still returns usable numbers rather than throwing.
    expect(result.netRevenue).toBe(100);
  });

  it("does not divide by zero on a free product", () => {
    const result = calculateMargin({
      price: 0,
      costs: { unitCost: 10 },
      rules: noRules,
      settings: ukSettings,
    });

    expect(Number.isFinite(result.netMarginPct)).toBe(true);
    expect(result.netMarginPct).toBe(0);
    expect(result.status).toBe("loss");
  });

  it("derives the discount already given away via compare-at price", () => {
    const result = calculateMargin({
      price: 80,
      compareAtPrice: 100,
      costs: { unitCost: 40 },
      rules: noRules,
      settings: usSettings,
    });

    expect(result.discountPct).toBe(20);
  });

  it("returns no discount when compare-at is absent or not a markdown", () => {
    const noCompare = calculateMargin({
      price: 80,
      costs: { unitCost: 40 },
      rules: noRules,
      settings: usSettings,
    });
    expect(noCompare.discountPct).toBeNull();

    const higherPrice = calculateMargin({
      price: 120,
      compareAtPrice: 100,
      costs: { unitCost: 40 },
      rules: noRules,
      settings: usSettings,
    });
    expect(higherPrice.discountPct).toBeNull();
  });
});

describe("break-even and target pricing", () => {
  it("break-even price yields exactly zero net profit when fed back in", () => {
    const rules = [paymentFee, pickPack];
    const costs = { unitCost: 60, freight: 4 };

    const first = calculateMargin({
      price: 120,
      costs,
      rules,
      settings: ukSettings,
    });

    expect(first.breakEvenPrice).not.toBeNull();

    const atBreakEven = calculateMargin({
      price: first.breakEvenPrice!,
      costs,
      rules,
      settings: ukSettings,
    });

    // Round-trips through a 2dp price, so allow a penny of slack.
    expect(Math.abs(atBreakEven.netProfit)).toBeLessThan(0.01);
  });

  it("target price yields the configured target margin when fed back in", () => {
    const rules = [paymentFee, pickPack];
    const costs = { unitCost: 60, freight: 4 };

    const first = calculateMargin({
      price: 120,
      costs,
      rules,
      settings: ukSettings,
    });

    expect(first.targetPrice).not.toBeNull();

    const atTarget = calculateMargin({
      price: first.targetPrice!,
      costs,
      rules,
      settings: ukSettings,
    });

    expect(Math.abs(atTarget.netMarginPct - ukSettings.targetMarginPct)).toBeLessThan(
      0.1,
    );
  });

  it("returns null when percentage costs plus target margin exceed 100%", () => {
    const greedy: CostRule = {
      id: "greedy",
      name: "Impossible fee",
      kind: "PERCENT_OF_REVENUE",
      value: 80,
      enabled: true,
    };

    expect(solvePriceForMargin(50, [greedy], ukSettings, 35)).toBeNull();
  });

  it("re-applies VAT so the suggested price is customer-facing", () => {
    // No fees, £60 landed, 40% target -> £100 net -> £120 inc VAT.
    const price = solvePriceForMargin(60, noRules, ukSettings, 40);
    expect(price).toBe(120);
  });
});

describe("aggregate", () => {
  const line = (
    price: number,
    unitCost: number | null,
    inventoryQuantity = 0,
    unitsSold = 0,
  ) => ({
    result: calculateMargin({
      price,
      costs: { unitCost },
      rules: noRules,
      settings: usSettings,
    }),
    inventoryQuantity,
    unitsSold,
  });

  it("counts variants by status and flags missing costs", () => {
    const totals = aggregate([
      line(100, 60), // 40% healthy
      line(100, 95), // 5%  critical
      line(100, 85), // 15% warn
      line(100, 110), // loss
      line(100, null), // unknown
    ]);

    expect(totals.variantCount).toBe(5);
    expect(totals.costedCount).toBe(4);
    expect(totals.missingCostCount).toBe(1);
    expect(totals.healthyCount).toBe(1);
    expect(totals.criticalCount).toBe(1);
    expect(totals.warnCount).toBe(1);
    expect(totals.lossCount).toBe(1);
  });

  it("weights average margin by revenue rather than taking a plain mean", () => {
    // A £2 item at 50% and a £400 item at 5%. The plain mean would be 27.5%,
    // which badly misrepresents the business.
    const totals = aggregate([line(2, 1), line(400, 380)]);

    const plainMean = (50 + 5) / 2;
    expect(totals.averageNetMarginPct).toBeLessThan(plainMean);
    // (1 + 20) / (2 + 400) = 5.2%
    expect(totals.averageNetMarginPct).toBeCloseTo(5.2, 1);
  });

  it("excludes uncosted variants from the weighted margin", () => {
    const withoutUncosted = aggregate([line(100, 60)]);
    const withUncosted = aggregate([line(100, 60), line(100, null)]);

    // The uncosted line must not drag the average toward a fictional 100%.
    expect(withUncosted.averageNetMarginPct).toBe(
      withoutUncosted.averageNetMarginPct,
    );
  });

  it("values stock on hand at both cost and retail", () => {
    const totals = aggregate([line(100, 60, 10)]);

    expect(totals.stockRetailValue).toBe(1000);
    expect(totals.stockCostValue).toBe(600);
    expect(totals.potentialProfit).toBe(400);
  });

  it("computes realised profit over units sold", () => {
    const totals = aggregate([line(100, 60, 0, 3), line(50, 20, 0, 2)]);

    // (40 x 3) + (30 x 2) = 180
    expect(totals.realisedProfit).toBe(180);
    expect(totals.realisedRevenue).toBe(400);
    expect(totals.realisedMarginPct).toBe(45);
  });

  it("returns zeroed totals for an empty catalogue", () => {
    const totals = aggregate([]);

    expect(totals.variantCount).toBe(0);
    expect(totals.averageNetMarginPct).toBe(0);
    expect(totals.realisedMarginPct).toBe(0);
    expect(Number.isFinite(totals.potentialProfit)).toBe(true);
  });
});
