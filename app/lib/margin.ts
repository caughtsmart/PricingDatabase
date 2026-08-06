/**
 * Landed-cost margin engine.
 *
 * This module is deliberately pure and dependency-free: it is the single source
 * of truth for every number the app shows, whether that is the widget on the
 * product page, the dashboard rollups, or a CSV export. Nothing here touches
 * Prisma, the network, or React.
 *
 * The model in one line:
 *
 *   net profit = net revenue − landed unit cost − variable costs
 *
 * where "net revenue" strips tax out of a tax-inclusive price, "landed unit
 * cost" is what the unit actually costs to have on the shelf (supplier price
 * plus freight, duty, packaging, handling), and "variable costs" are the
 * shop-wide charges that scale with the sale (payment fees, channel fees,
 * pick-and-pack).
 *
 * Most margin tools stop at `(price - cost) / price`, which flatters every
 * number on the page. The extra terms here are the whole point of the app.
 */

/** How a shop-wide cost rule is applied to a sale. */
export type CostRuleKind =
  /** A percentage of net (tax-exclusive) revenue, e.g. a 1.75% payment fee. */
  | "PERCENT_OF_REVENUE"
  /** A flat amount charged per unit sold, e.g. £0.45 pick-and-pack. */
  | "FIXED_PER_UNIT";

export interface CostRule {
  id: string;
  name: string;
  kind: CostRuleKind;
  /** Percentage points for PERCENT_OF_REVENUE, currency amount for FIXED_PER_UNIT. */
  value: number;
  enabled: boolean;
}

/** Per-variant cost components that sit on top of Shopify's unit cost. */
export interface VariantCostInputs {
  /** Shopify's `InventoryItem.unitCost` ("Cost per item"). Null when unset. */
  unitCost: number | null;
  freight?: number | null;
  duty?: number | null;
  packaging?: number | null;
  handling?: number | null;
  other?: number | null;
}

export interface MarginSettings {
  /** True when the shop's displayed prices already include tax (typical in the UK/EU). */
  pricesIncludeTax: boolean;
  /** Tax rate in percentage points, e.g. 20 for UK VAT. */
  taxRatePct: number;
  /** Net margin the merchant is aiming for; drives the suggested price. */
  targetMarginPct: number;
  /** Net margin below which a variant is flagged amber. */
  warnMarginPct: number;
  /** Net margin below which a variant is flagged red. */
  criticalMarginPct: number;
}

export interface MarginInput {
  /** The variant's selling price as shown in the admin. */
  price: number;
  compareAtPrice?: number | null;
  costs: VariantCostInputs;
  rules: CostRule[];
  settings: MarginSettings;
}

export type MarginStatus =
  /** No unit cost recorded, so margin cannot be computed. */
  | "unknown"
  /** Selling at or below total cost. */
  | "loss"
  | "critical"
  | "warn"
  | "healthy";

export interface AppliedCost {
  id: string;
  name: string;
  kind: CostRuleKind;
  /** The rule's configured value, echoed so the UI can show "1.75%" vs "£0.45". */
  value: number;
  /** The resolved currency amount for this sale. */
  amount: number;
}

export interface MarginResult {
  /** Price as entered, tax included if the shop prices that way. */
  grossRevenue: number;
  /** Revenue actually retained after tax. This is the denominator for margin. */
  netRevenue: number;
  taxAmount: number;

  unitCost: number;
  /** Sum of the per-variant extras (freight, duty, packaging, handling, other). */
  extraUnitCost: number;
  /** unitCost + extraUnitCost. What the unit costs to sit on the shelf. */
  landedUnitCost: number;

  appliedCosts: AppliedCost[];
  totalVariableCost: number;
  /** landedUnitCost + totalVariableCost. */
  totalCost: number;

  /** netRevenue − landedUnitCost. Ignores shop-wide rules. */
  grossProfit: number;
  grossMarginPct: number;

  /** netRevenue − totalCost. The number the merchant actually banks. */
  netProfit: number;
  netMarginPct: number;
  /** Net profit as a percentage of total cost. */
  markupPct: number;

  /** Gross price at which net profit is exactly zero. Null if unsolvable. */
  breakEvenPrice: number | null;
  /** Gross price that would hit `settings.targetMarginPct`. Null if unsolvable. */
  targetPrice: number | null;

  /** Discount already being given away via compare-at price, as a % of compare-at. */
  discountPct: number | null;

  status: MarginStatus;
  /** False when no unit cost is recorded — every figure above is then indicative only. */
  hasCostData: boolean;
}

/** Rounds to 2dp using half-away-from-zero, avoiding the usual float surprises. */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const scaled = value * 100;
  // 1e-9 nudge keeps 8.325 -> 8.33 rather than 8.32 from binary representation.
  const rounded =
    scaled >= 0
      ? Math.round(scaled + 1e-9)
      : -Math.round(-scaled + 1e-9);
  return rounded / 100;
}

/** Rounds a percentage to 1dp. */
export function roundPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10 + (value >= 0 ? 1e-9 : -1e-9)) / 10;
}

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Strips tax from a gross price when the shop prices tax-inclusive. */
export function toNetRevenue(price: number, settings: MarginSettings): number {
  if (!settings.pricesIncludeTax) return price;
  const rate = num(settings.taxRatePct);
  // A rate of -100% (or worse) would divide by zero or flip the sign.
  if (rate <= -100) return price;
  return price / (1 + rate / 100);
}

/** Re-applies tax, turning a net figure back into a customer-facing price. */
function toGrossPrice(netRevenue: number, settings: MarginSettings): number {
  if (!settings.pricesIncludeTax) return netRevenue;
  const rate = num(settings.taxRatePct);
  if (rate <= -100) return netRevenue;
  return netRevenue * (1 + rate / 100);
}

export function sumExtraUnitCost(costs: VariantCostInputs): number {
  return (
    num(costs.freight) +
    num(costs.duty) +
    num(costs.packaging) +
    num(costs.handling) +
    num(costs.other)
  );
}

function activeRules(rules: CostRule[]): CostRule[] {
  return rules.filter((rule) => rule.enabled);
}

/** Total percentage-of-revenue rate across all enabled rules. */
function percentRate(rules: CostRule[]): number {
  return activeRules(rules)
    .filter((rule) => rule.kind === "PERCENT_OF_REVENUE")
    .reduce((total, rule) => total + num(rule.value), 0);
}

/** Total flat per-unit charge across all enabled rules. */
function fixedPerUnit(rules: CostRule[]): number {
  return activeRules(rules)
    .filter((rule) => rule.kind === "FIXED_PER_UNIT")
    .reduce((total, rule) => total + num(rule.value), 0);
}

/**
 * Solves for the gross price that yields `desiredMarginPct` net margin.
 *
 * Starting from `netProfit = netRev − landed − netRev·r − fixed` and requiring
 * `netProfit = desiredMargin · netRev`:
 *
 *   netRev · (1 − r − m) = landed + fixed
 *   netRev = (landed + fixed) / (1 − r − m)
 *
 * Returns null when the denominator is zero or negative, which means the
 * percentage costs plus the desired margin consume 100% or more of revenue —
 * no finite price gets you there.
 */
export function solvePriceForMargin(
  landedUnitCost: number,
  rules: CostRule[],
  settings: MarginSettings,
  desiredMarginPct: number,
): number | null {
  const r = percentRate(rules) / 100;
  const m = num(desiredMarginPct) / 100;
  const denominator = 1 - r - m;
  if (denominator <= 1e-9) return null;

  const netRevenue = (landedUnitCost + fixedPerUnit(rules)) / denominator;
  if (!Number.isFinite(netRevenue) || netRevenue < 0) return null;

  return roundMoney(toGrossPrice(netRevenue, settings));
}

function classify(
  result: Pick<MarginResult, "netProfit" | "netMarginPct">,
  hasCostData: boolean,
  settings: MarginSettings,
): MarginStatus {
  if (!hasCostData) return "unknown";
  if (result.netProfit < 0) return "loss";
  if (result.netMarginPct < settings.criticalMarginPct) return "critical";
  if (result.netMarginPct < settings.warnMarginPct) return "warn";
  return "healthy";
}

/**
 * Computes the full margin breakdown for a single variant at a single price.
 *
 * Safe to call with missing cost data: `hasCostData` reports whether a unit
 * cost was actually recorded, and callers should treat the figures as
 * indicative when it is false rather than hiding the row entirely — a variant
 * with no cost is exactly the one a merchant needs to be told about.
 */
export function calculateMargin(input: MarginInput): MarginResult {
  const { settings, rules } = input;

  const grossRevenue = num(input.price);
  const netRevenue = toNetRevenue(grossRevenue, settings);
  const taxAmount = grossRevenue - netRevenue;

  const hasCostData =
    typeof input.costs.unitCost === "number" &&
    Number.isFinite(input.costs.unitCost);

  const unitCost = num(input.costs.unitCost);
  const extraUnitCost = sumExtraUnitCost(input.costs);
  const landedUnitCost = unitCost + extraUnitCost;

  const appliedCosts: AppliedCost[] = activeRules(rules).map((rule) => ({
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    value: num(rule.value),
    amount: roundMoney(
      rule.kind === "PERCENT_OF_REVENUE"
        ? (netRevenue * num(rule.value)) / 100
        : num(rule.value),
    ),
  }));

  const totalVariableCost = appliedCosts.reduce(
    (total, cost) => total + cost.amount,
    0,
  );
  const totalCost = landedUnitCost + totalVariableCost;

  const grossProfit = netRevenue - landedUnitCost;
  const netProfit = netRevenue - totalCost;

  // Guard the divisions: a £0 price (or a zero-cost freebie) must not produce
  // Infinity or NaN on a merchant's dashboard.
  const grossMarginPct = netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0;
  const netMarginPct = netRevenue > 0 ? (netProfit / netRevenue) * 100 : 0;
  const markupPct = totalCost > 0 ? (netProfit / totalCost) * 100 : 0;

  const compareAt = num(input.compareAtPrice);
  const discountPct =
    compareAt > grossRevenue && compareAt > 0
      ? roundPct(((compareAt - grossRevenue) / compareAt) * 100)
      : null;

  const status = classify({ netProfit, netMarginPct }, hasCostData, settings);

  return {
    grossRevenue: roundMoney(grossRevenue),
    netRevenue: roundMoney(netRevenue),
    taxAmount: roundMoney(taxAmount),

    unitCost: roundMoney(unitCost),
    extraUnitCost: roundMoney(extraUnitCost),
    landedUnitCost: roundMoney(landedUnitCost),

    appliedCosts,
    totalVariableCost: roundMoney(totalVariableCost),
    totalCost: roundMoney(totalCost),

    grossProfit: roundMoney(grossProfit),
    grossMarginPct: roundPct(grossMarginPct),

    netProfit: roundMoney(netProfit),
    netMarginPct: roundPct(netMarginPct),
    markupPct: roundPct(markupPct),

    breakEvenPrice: solvePriceForMargin(landedUnitCost, rules, settings, 0),
    targetPrice: solvePriceForMargin(
      landedUnitCost,
      rules,
      settings,
      settings.targetMarginPct,
    ),

    discountPct,
    status,
    hasCostData,
  };
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

export interface AggregateLine {
  result: MarginResult;
  /** Units on hand, used to value stock. Defaults to 0. */
  inventoryQuantity?: number | null;
  /** Units sold in the reporting window, used to weight realised margin. */
  unitsSold?: number | null;
}

export interface AggregateTotals {
  variantCount: number;
  /** Variants with a recorded unit cost. */
  costedCount: number;
  /** Variants with no unit cost — the dashboard's "needs attention" number. */
  missingCostCount: number;
  lossCount: number;
  criticalCount: number;
  warnCount: number;
  healthyCount: number;

  /**
   * Revenue-weighted average net margin across variants that have cost data.
   *
   * Weighted rather than a plain mean: a plain mean lets a £2 keyring with a
   * 70% margin cancel out a £400 boxed set at 4%, which is exactly the
   * distortion the merchant is trying to see through.
   */
  averageNetMarginPct: number;

  /** Retail value of stock on hand, at net revenue. */
  stockRetailValue: number;
  /** Landed cost value of stock on hand. */
  stockCostValue: number;
  /** Profit locked up in current stock if it all sold at today's prices. */
  potentialProfit: number;

  /** Net profit across `unitsSold` in the window. */
  realisedProfit: number;
  realisedRevenue: number;
  realisedMarginPct: number;
}

/**
 * Rolls a set of per-variant results into the numbers on the dashboard.
 *
 * Variants without cost data are counted (so the merchant sees the gap) but
 * excluded from the weighted margin, because including them would silently
 * report a 100% margin on anything uncosted.
 */
export function aggregate(lines: AggregateLine[]): AggregateTotals {
  const totals: AggregateTotals = {
    variantCount: lines.length,
    costedCount: 0,
    missingCostCount: 0,
    lossCount: 0,
    criticalCount: 0,
    warnCount: 0,
    healthyCount: 0,
    averageNetMarginPct: 0,
    stockRetailValue: 0,
    stockCostValue: 0,
    potentialProfit: 0,
    realisedProfit: 0,
    realisedRevenue: 0,
    realisedMarginPct: 0,
  };

  let weightedProfit = 0;
  let weightedRevenue = 0;

  for (const line of lines) {
    const { result } = line;

    if (!result.hasCostData) {
      totals.missingCostCount += 1;
    } else {
      totals.costedCount += 1;
    }

    switch (result.status) {
      case "loss":
        totals.lossCount += 1;
        break;
      case "critical":
        totals.criticalCount += 1;
        break;
      case "warn":
        totals.warnCount += 1;
        break;
      case "healthy":
        totals.healthyCount += 1;
        break;
      default:
        break;
    }

    if (result.hasCostData) {
      // Weight by net revenue per unit so expensive lines dominate, as they
      // do in reality.
      weightedProfit += result.netProfit;
      weightedRevenue += result.netRevenue;

      const stock = Math.max(0, num(line.inventoryQuantity));
      if (stock > 0) {
        totals.stockRetailValue += result.netRevenue * stock;
        totals.stockCostValue += result.landedUnitCost * stock;
        totals.potentialProfit += result.netProfit * stock;
      }

      const sold = Math.max(0, num(line.unitsSold));
      if (sold > 0) {
        totals.realisedProfit += result.netProfit * sold;
        totals.realisedRevenue += result.netRevenue * sold;
      }
    }
  }

  totals.averageNetMarginPct =
    weightedRevenue > 0 ? roundPct((weightedProfit / weightedRevenue) * 100) : 0;
  totals.realisedMarginPct =
    totals.realisedRevenue > 0
      ? roundPct((totals.realisedProfit / totals.realisedRevenue) * 100)
      : 0;

  totals.stockRetailValue = roundMoney(totals.stockRetailValue);
  totals.stockCostValue = roundMoney(totals.stockCostValue);
  totals.potentialProfit = roundMoney(totals.potentialProfit);
  totals.realisedProfit = roundMoney(totals.realisedProfit);
  totals.realisedRevenue = roundMoney(totals.realisedRevenue);

  return totals;
}
