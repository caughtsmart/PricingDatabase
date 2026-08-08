import type { MarginResult, MarginStatus } from "./margin";

/**
 * The money waterfall — the signature component from `docs/DESIGN.md` §5.
 *
 * One horizontal bar representing the selling price; each cost takes a bite;
 * what remains is profit. This module builds the segments; rendering happens
 * elsewhere. It lives server-side next to the engine so the product-page
 * widget receives finished segments from `/api/margin` and computes nothing —
 * the boundary that keeps the widget and the dashboard telling the same story.
 *
 * Segment order is the order the engine calculates: tax out, landed cost,
 * each applied cost in rule order, profit last.
 */

export type WaterfallTone =
  | "neutral"
  | "info"
  | "warning"
  | "critical"
  | "success";

export interface WaterfallSegment {
  /** Stable key for selection state: "tax", "landed", a rule id, or "profit". */
  key: string;
  label: string;
  /** Currency amount. Negative only for a loss-making profit segment. */
  amount: number;
  /**
   * Share of the gross price, 0..1. The profit segment's share is negative on
   * a loss — DESIGN.md wants losing money to *look* wrong, and a renderer
   * needs the sign to draw the overshoot.
   */
  share: number;
  kind: "tax" | "cost" | "profit";
  tone: WaterfallTone;
}

export interface Waterfall {
  /** The gross price the bar represents. */
  price: number;
  segments: WaterfallSegment[];
  isLoss: boolean;
  /**
   * False when no unit cost is recorded. The renderer must not present the
   * bar as settled fact — and the profit tone is never green in this state,
   * because missing data must not look like health.
   */
  hasCostData: boolean;
}

/** The profit segment's tone, from the engine's own status classification. */
function profitTone(status: MarginStatus, hasCostData: boolean): WaterfallTone {
  if (!hasCostData) return "info";
  switch (status) {
    case "loss":
    case "critical":
      return "critical";
    case "warn":
      return "warning";
    case "healthy":
      return "success";
    default:
      return "info";
  }
}

/**
 * Builds the waterfall for one variant at one price.
 *
 * Zero-amount cost segments are dropped — a disabled or zero rule takes no
 * visible bite, and the itemised walk below the bar is where "this rule
 * contributed £0.00" belongs. The profit segment is always present, even at
 * zero, because "nothing left" is the whole message.
 */
export function buildWaterfall(result: MarginResult): Waterfall {
  const price = result.grossRevenue;
  // A £0 price still yields a valid (all-zero-share) waterfall; never NaN.
  const shareOf = (amount: number) => (price > 0 ? amount / price : 0);

  const segments: WaterfallSegment[] = [];

  if (result.taxAmount > 0) {
    segments.push({
      key: "tax",
      label: "Tax",
      amount: result.taxAmount,
      share: shareOf(result.taxAmount),
      kind: "tax",
      tone: "neutral",
    });
  }

  if (result.landedUnitCost > 0) {
    segments.push({
      key: "landed",
      label: "Landed cost",
      amount: result.landedUnitCost,
      share: shareOf(result.landedUnitCost),
      kind: "cost",
      tone: "neutral",
    });
  }

  if (result.extraPriceLinkedCost > 0) {
    segments.push({
      key: "price-linked",
      label: "Costs tied to the price",
      amount: result.extraPriceLinkedCost,
      share: shareOf(result.extraPriceLinkedCost),
      kind: "cost",
      tone: "neutral",
    });
  }

  for (const cost of result.appliedCosts) {
    if (cost.amount === 0) continue;
    segments.push({
      key: cost.id,
      label: cost.name,
      amount: cost.amount,
      share: shareOf(cost.amount),
      kind: "cost",
      tone: "neutral",
    });
  }

  segments.push({
    key: "profit",
    label: result.netProfit < 0 ? "Loss" : "Profit",
    amount: result.netProfit,
    share: shareOf(result.netProfit),
    kind: "profit",
    tone: profitTone(result.status, result.hasCostData),
  });

  return {
    price,
    segments,
    isLoss: result.netProfit < 0,
    hasCostData: result.hasCostData,
  };
}
