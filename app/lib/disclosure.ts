/**
 * Progressive disclosure (MARGIN-MODEL.md §4, DESIGN.md §7).
 *
 * Three levels control what the widget shows *by default* — never what
 * exists, and never what is counted. Every margin figure includes every
 * enabled cost at every level; a level only decides how much of the working
 * is on screen. Anything hidden is announced by a chip, because a number a
 * merchant is trusting must not have silent exclusions.
 *
 * Pure and dependency-free, like the engine: these rules decide what a
 * beginner sees first, which makes them exactly the kind of invisible-when-
 * wrong logic that gets unit-tested directly.
 */

export type DisclosureLevel = 1 | 2 | 3;

/** Coerces an untrusted value (DB integer, form field) to a valid level. */
export function clampLevel(raw: unknown): DisclosureLevel {
  const parsed = Number(raw);
  if (parsed === 2 || parsed === 3) return parsed;
  return 1;
}

/**
 * What each level shows. Levels are cumulative by design: a `true` at level
 * N is `true` at every level above it, which is the doc's "moving up never
 * re-asks, moving down hides, never deletes" made mechanical. The
 * monotonicity test in disclosure.test.ts enforces it.
 *
 * Deliberately *not* gated, at any level: the status badge, net margin and
 * markup side by side (DESIGN.md §8 calls that pairing non-negotiable), and
 * the unit-cost field — the app is pointless without a cost to enter.
 */
export interface DisclosureView {
  /** The money waterfall bar. */
  waterfall: boolean;
  /** The line-by-line walk from price to profit. */
  walk: boolean;
  /** Itemise each shop-wide rule in the walk; below this they sum to one row. */
  itemisedRules: boolean;
  /** Break-even and target-price stats. */
  stats: boolean;
  /** The editable cost-block list and its add buttons. */
  blocks: boolean;
  /** The lock-and-solve panel. */
  solve: boolean;
  /** Profit-if-stock-sells and the compare-at discount note. */
  stockAndDiscount: boolean;
}

export function viewForLevel(level: DisclosureLevel): DisclosureView {
  return {
    waterfall: level >= 2,
    walk: level >= 2,
    itemisedRules: level >= 3,
    stats: level >= 2,
    blocks: level >= 2,
    solve: level >= 2,
    stockAndDiscount: level >= 3,
  };
}

/** The levels as the settings page offers them, plainly named. */
export const LEVEL_OPTIONS: Array<{
  level: DisclosureLevel;
  label: string;
  description: string;
}> = [
  {
    level: 1,
    label: "Am I losing money?",
    description:
      "One number and a health check per product. Best while you are still entering costs.",
  },
  {
    level: 2,
    label: "The real number",
    description:
      "Adds the money waterfall, break-even, cost blocks and the price solver.",
  },
  {
    level: 3,
    label: "Full unit economics",
    description:
      "Every cost line itemised, plus stock profit and discount detail.",
  },
];

/**
 * The chip for costs that exist but are folded away at this level.
 *
 * Levels hide *working*, not money — so when any enabled cost is not
 * individually on screen, say so and offer the peek. Returns null when
 * nothing is folded away (or there are no costs to fold).
 */
export function hiddenCostSummary(
  level: DisclosureLevel,
  enabledBlockCount: number,
  appliedRuleCount: number,
): string | null {
  const folded =
    level === 1
      ? enabledBlockCount + appliedRuleCount
      : level === 2
        ? appliedRuleCount > 1
          ? appliedRuleCount
          : 0
        : 0;

  if (folded === 0) return null;
  const noun = folded === 1 ? "cost is" : "costs are";
  return `${folded} ${noun} folded into the numbers above`;
}

/**
 * The level-1 nudge (MARGIN-MODEL.md §4): "Most sellers forget three things
 * — payment fees, postage, returns." One tap adds these as draft blocks,
 * labelled and ready for real figures — values stay at 0 rather than being
 * invented, because a plausible made-up number would be wrong and invisible.
 * Payment fees are left out of the list when a shop-wide rule already covers
 * them; adding a block too would count the same money twice.
 */
export const NUDGE_BLOCKS: Array<{
  label: string;
  kind: "FIXED_PER_UNIT" | "PERCENT_OF_COST";
}> = [
  { label: "Postage", kind: "FIXED_PER_UNIT" },
  { label: "Packaging", kind: "FIXED_PER_UNIT" },
  { label: "Returns allowance", kind: "PERCENT_OF_COST" },
];
