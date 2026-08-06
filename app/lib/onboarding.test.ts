import { describe, expect, it } from "vitest";

import { calculateMargin } from "./margin";
import {
  describeDetection,
  deriveTaxDefaults,
  standardTaxRateForCountry,
} from "./onboarding";

describe("standardTaxRateForCountry", () => {
  it("returns the standard rate for a known country", () => {
    expect(standardTaxRateForCountry("GB")).toBe(20);
    expect(standardTaxRateForCountry("DE")).toBe(19);
    expect(standardTaxRateForCountry("AU")).toBe(10);
  });

  it("normalises case and whitespace", () => {
    expect(standardTaxRateForCountry(" gb ")).toBe(20);
  });

  it("returns null rather than zero for an unknown country", () => {
    // Zero would claim there is no tax; null says we do not know, which is the
    // difference between a silent wrong answer and a prompt.
    expect(standardTaxRateForCountry("ZZ")).toBeNull();
    expect(standardTaxRateForCountry(null)).toBeNull();
    expect(standardTaxRateForCountry("")).toBeNull();
  });
});

describe("deriveTaxDefaults", () => {
  it("detects a UK tax-inclusive shop", () => {
    const defaults = deriveTaxDefaults({
      taxesIncluded: true,
      countryCode: "GB",
      currencyCode: "GBP",
    });

    expect(defaults.pricesIncludeTax).toBe(true);
    expect(defaults.taxRatePct).toBe(20);
    expect(defaults.needsRateConfirmation).toBe(false);
  });

  it("forces the rate to zero when prices exclude tax", () => {
    // A US store adds sales tax at checkout. Storing a rate would be a trap for
    // whoever later flips the tax-inclusive switch.
    const defaults = deriveTaxDefaults({
      taxesIncluded: false,
      countryCode: "US",
      currencyCode: "USD",
    });

    expect(defaults.pricesIncludeTax).toBe(false);
    expect(defaults.taxRatePct).toBe(0);
    expect(defaults.needsRateConfirmation).toBe(false);
  });

  it("ignores a known country's rate when prices exclude tax", () => {
    const defaults = deriveTaxDefaults({
      taxesIncluded: false,
      countryCode: "GB",
      currencyCode: "GBP",
    });

    expect(defaults.taxRatePct).toBe(0);
  });

  it("flags for confirmation when the country is unknown but prices include tax", () => {
    const defaults = deriveTaxDefaults({
      taxesIncluded: true,
      countryCode: "ZZ",
      currencyCode: "XYZ",
    });

    expect(defaults.pricesIncludeTax).toBe(true);
    expect(defaults.taxRatePct).toBe(0);
    expect(defaults.needsRateConfirmation).toBe(true);
  });

  it("flags for confirmation when the shop has no address", () => {
    const defaults = deriveTaxDefaults({
      taxesIncluded: true,
      countryCode: null,
      currencyCode: "EUR",
    });

    expect(defaults.needsRateConfirmation).toBe(true);
  });

  it("carries the currency through", () => {
    expect(
      deriveTaxDefaults({
        taxesIncluded: true,
        countryCode: "SE",
        currencyCode: "SEK",
      }).currencyCode,
    ).toBe("SEK");
  });
});

describe("detected defaults feed the margin engine correctly", () => {
  const baseSettings = {
    targetMarginPct: 35,
    warnMarginPct: 20,
    criticalMarginPct: 10,
  };

  it("a UK shop reports margin net of VAT", () => {
    const detected = deriveTaxDefaults({
      taxesIncluded: true,
      countryCode: "GB",
      currencyCode: "GBP",
    });

    const result = calculateMargin({
      price: 120,
      costs: { unitCost: 60 },
      rules: [],
      settings: {
        ...baseSettings,
        pricesIncludeTax: detected.pricesIncludeTax,
        taxRatePct: detected.taxRatePct,
      },
    });

    // The whole point of the detection: 40%, not the 50% a naive calculation
    // would report.
    expect(result.netRevenue).toBe(100);
    expect(result.netMarginPct).toBe(40);
  });

  it("a US shop reports margin on the full price", () => {
    const detected = deriveTaxDefaults({
      taxesIncluded: false,
      countryCode: "US",
      currencyCode: "USD",
    });

    const result = calculateMargin({
      price: 120,
      costs: { unitCost: 60 },
      rules: [],
      settings: {
        ...baseSettings,
        pricesIncludeTax: detected.pricesIncludeTax,
        taxRatePct: detected.taxRatePct,
      },
    });

    expect(result.netRevenue).toBe(120);
    expect(result.netMarginPct).toBe(50);
  });
});

describe("describeDetection", () => {
  it("explains a tax-exclusive shop", () => {
    const message = describeDetection(
      deriveTaxDefaults({
        taxesIncluded: false,
        countryCode: "US",
        currencyCode: "USD",
      }),
    );
    expect(message).toContain("exclude tax");
  });

  it("names the detected rate", () => {
    const message = describeDetection(
      deriveTaxDefaults({
        taxesIncluded: true,
        countryCode: "GB",
        currencyCode: "GBP",
      }),
    );
    expect(message).toContain("20%");
  });

  it("warns when the rate could not be worked out", () => {
    const message = describeDetection(
      deriveTaxDefaults({
        taxesIncluded: true,
        countryCode: null,
        currencyCode: "EUR",
      }),
    );
    expect(message).toContain("overstated");
  });
});
