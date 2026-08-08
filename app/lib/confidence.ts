import {
  componentsToCostInputs,
  type ComponentConfidence,
  type CostComponentInput,
} from "./components";
import { calculateMargin, type MarginInput } from "./margin";

/**
 * Confidence bands (MARGIN-MODEL.md §2.5): a margin built on guesses is a
 * range, not gospel, and the app should say so.
 *
 * Every cost block carries KNOWN | ESTIMATED | GUESSED. Each tag maps to an
 * uncertainty on the block's value; running the engine with every uncertain
 * block pushed to its costly end and again at its cheap end brackets the
 * headline margin — "31%, likely 26–36%". The same arithmetic per block,
 * one at a time, ranks the "tighten this up" list by how much certainty
 * each guess is costing.
 *
 * Pure, like the engine and for the same reason: a wrong band looks exactly
 * like a right one, so this is tested directly. Shopify's unit cost and the
 * shop-wide rules carry no tag and are treated as exact — the band reflects
 * only what the merchant has told us is shaky.
 */

/** Relative uncertainty on a block's value, by how sure the merchant is. */
export const UNCERTAINTY: Record<ComponentConfidence, number> = {
  KNOWN: 0,
  // An estimate from memory is usually within a fifth; a guess can be half
  // out either way. Coarse on purpose — the band's job is honesty about
  // roughly how wrong the number could be, not false precision about it.
  ESTIMATED: 0.2,
  GUESSED: 0.5,
};

/** Bands narrower than this (in margin points) are rounding noise, not doubt. */
const MIN_BAND_PTS = 0.05;

export interface BandInput {
  price: number;
  compareAtPrice?: number | null;
  unitCost: number | null;
  components: CostComponentInput[];
  rules: MarginInput["rules"];
  settings: MarginInput["settings"];
  context?: MarginInput["context"];
}

export interface ConfidenceBand {
  /** Net margin with every uncertain cost at its expensive end. */
  lowPct: number;
  /** Net margin with every uncertain cost at its cheap end. */
  highPct: number;
}

export interface TightenSuggestion {
  id: string;
  label: string;
  confidence: ComponentConfidence;
  /** Margin points this one block's uncertainty spans on its own. */
  swingPts: number;
}

function uncertaintyOf(component: CostComponentInput): number {
  return UNCERTAINTY[component.confidence ?? "ESTIMATED"];
}

/**
 * Scales uncertain block values towards more cost (+1) or less (−1).
 *
 * `value + direction × |value| × u` rather than `value × (1 ± u)` so a
 * negative value (a rebate) behaves correctly: its costly end is a smaller
 * rebate, not a bigger one.
 */
function scaled(
  components: CostComponentInput[],
  direction: 1 | -1,
  onlyId?: string,
): CostComponentInput[] {
  return components.map((component) => {
    if (onlyId !== undefined && component.id !== onlyId) return component;
    const uncertainty = uncertaintyOf(component);
    if (uncertainty === 0) return component;
    const value = Number(component.value);
    if (!Number.isFinite(value) || value === 0) return component;
    return {
      ...component,
      value: value + direction * Math.abs(value) * uncertainty,
    };
  });
}

function marginAt(
  input: BandInput,
  components: CostComponentInput[],
): ReturnType<typeof calculateMargin> {
  return calculateMargin({
    price: input.price,
    compareAtPrice: input.compareAtPrice ?? null,
    costs: componentsToCostInputs(input.unitCost, components),
    rules: input.rules,
    settings: input.settings,
    context: input.context,
  });
}

/**
 * The headline band, or null when there is nothing honest to say: no cost
 * data, or every contributing block is KNOWN (a muted or zero-value guess
 * moves nothing, so it produces no band either — the width check handles
 * that without re-deriving the tree rules here).
 */
export function confidenceBand(input: BandInput): ConfidenceBand | null {
  const nominal = marginAt(input, input.components);
  if (!nominal.hasCostData) return null;

  const lowPct = marginAt(input, scaled(input.components, 1)).netMarginPct;
  const highPct = marginAt(input, scaled(input.components, -1)).netMarginPct;
  if (highPct - lowPct < MIN_BAND_PTS) return null;

  return { lowPct, highPct };
}

/**
 * The blocks whose uncertainty costs the most certainty, worst first — the
 * ranked "tighten this up" list. Each block is swung alone so its share of
 * the band is its own, not the ensemble's.
 */
export function tightenSuggestions(
  input: BandInput,
  limit = 3,
): TightenSuggestion[] {
  if (!marginAt(input, input.components).hasCostData) return [];

  const suggestions: TightenSuggestion[] = [];
  for (const component of input.components) {
    if (uncertaintyOf(component) === 0) continue;

    const lowPct = marginAt(
      input,
      scaled(input.components, 1, component.id),
    ).netMarginPct;
    const highPct = marginAt(
      input,
      scaled(input.components, -1, component.id),
    ).netMarginPct;
    const swingPts = highPct - lowPct;
    if (swingPts < MIN_BAND_PTS) continue;

    suggestions.push({
      id: component.id,
      label: component.label,
      confidence: component.confidence ?? "ESTIMATED",
      swingPts,
    });
  }

  return suggestions
    .sort((a, b) => b.swingPts - a.swingPts)
    .slice(0, Math.max(0, limit));
}
