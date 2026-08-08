import { describe, expect, it } from "vitest";

import type { CostComponentInput } from "./components";
import {
  confidenceBand,
  tightenSuggestions,
  type BandInput,
} from "./confidence";
import type { MarginSettings } from "./margin";

// Tax-free, rule-free settings so expected margins are hand-checkable.
const settings: MarginSettings = {
  pricesIncludeTax: false,
  taxRatePct: 0,
  targetMarginPct: 35,
  warnMarginPct: 20,
  criticalMarginPct: 10,
};

const block = (
  overrides: Partial<CostComponentInput> & Pick<CostComponentInput, "id">,
): CostComponentInput => ({
  parentId: null,
  label: overrides.id,
  kind: "FIXED_PER_UNIT",
  value: 0,
  ...overrides,
});

const input = (
  components: CostComponentInput[],
  unitCost: number | null = 40,
): BandInput => ({
  price: 100,
  unitCost,
  components,
  rules: [],
  settings,
});

describe("confidenceBand", () => {
  it("brackets the margin around a guessed block", () => {
    // £40 unit cost + £10 guessed freight: the guess spans £5–£15, so
    // landed cost spans £45–£55 and margin spans 45%–55%.
    const band = confidenceBand(
      input([block({ id: "freight", value: 10, confidence: "GUESSED" })]),
    );

    expect(band).not.toBeNull();
    expect(band?.lowPct).toBeCloseTo(45, 1);
    expect(band?.highPct).toBeCloseTo(55, 1);
  });

  it("uses the tighter spread for an estimate", () => {
    const band = confidenceBand(
      input([block({ id: "freight", value: 10, confidence: "ESTIMATED" })]),
    );

    expect(band?.lowPct).toBeCloseTo(48, 1);
    expect(band?.highPct).toBeCloseTo(52, 1);
  });

  it("is null when every block is known — certainty has no band", () => {
    expect(
      confidenceBand(
        input([block({ id: "freight", value: 10, confidence: "KNOWN" })]),
      ),
    ).toBeNull();
  });

  it("is null when there is no cost data at all", () => {
    expect(
      confidenceBand(
        input([block({ id: "freight", value: 10, confidence: "GUESSED" })], null),
      ),
    ).toBeNull();
  });

  it("ignores muted guesses — they move no money", () => {
    expect(
      confidenceBand(
        input([
          block({
            id: "freight",
            value: 10,
            confidence: "GUESSED",
            enabled: false,
          }),
        ]),
      ),
    ).toBeNull();
  });

  it("ignores guesses inside a muted group", () => {
    expect(
      confidenceBand(
        input([
          block({ id: "landed", kind: "GROUP", enabled: false }),
          block({
            id: "freight",
            parentId: "landed",
            value: 10,
            confidence: "GUESSED",
          }),
        ]),
      ),
    ).toBeNull();
  });

  it("a zero-value guess produces no band", () => {
    expect(
      confidenceBand(
        input([block({ id: "postage", value: 0, confidence: "GUESSED" })]),
      ),
    ).toBeNull();
  });

  it("treats a guessed rebate's costly end as a smaller rebate", () => {
    // A −10% goods rebate guessed: costly end −5%, cheap end −15%. With
    // £40 unit cost the landed cost spans £34–£38, margin 62%–66%.
    const band = confidenceBand(
      input([
        block({
          id: "rebate",
          kind: "PERCENT_OF_COST",
          value: -10,
          confidence: "GUESSED",
        }),
      ]),
    );

    expect(band?.lowPct).toBeCloseTo(62, 1);
    expect(band?.highPct).toBeCloseTo(66, 1);
    expect(band && band.lowPct < band.highPct).toBe(true);
  });
});

describe("tightenSuggestions", () => {
  it("ranks the loosest block first and skips the known", () => {
    const suggestions = tightenSuggestions(
      input([
        block({ id: "freight", value: 2, confidence: "GUESSED" }),
        block({ id: "duty", value: 10, confidence: "GUESSED" }),
        block({ id: "packaging", value: 50, confidence: "KNOWN" }),
      ]),
    );

    expect(suggestions.map((suggestion) => suggestion.id)).toEqual([
      "duty",
      "freight",
    ]);
    // Duty alone spans £5–£15 of cost, i.e. 10 margin points on a £100 price.
    expect(suggestions[0].swingPts).toBeCloseTo(10, 1);
  });

  it("honours the limit", () => {
    const suggestions = tightenSuggestions(
      input([
        block({ id: "a", value: 5, confidence: "GUESSED" }),
        block({ id: "b", value: 6, confidence: "GUESSED" }),
        block({ id: "c", value: 7, confidence: "GUESSED" }),
        block({ id: "d", value: 8, confidence: "GUESSED" }),
      ]),
      2,
    );

    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].id).toBe("d");
  });

  it("is empty with no cost data", () => {
    expect(
      tightenSuggestions(
        input([block({ id: "freight", value: 10, confidence: "GUESSED" })], null),
      ),
    ).toEqual([]);
  });
});
