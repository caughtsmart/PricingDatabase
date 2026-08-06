/**
 * Working out a shop's tax setup at install time.
 *
 * This is the highest-consequence guess the app makes. The margin engine
 * divides tax out of tax-inclusive prices, so getting `pricesIncludeTax` wrong
 * moves every margin in the shop by the tax rate — and it does so silently. A
 * UK store left on the wrong setting would see a 50% margin reported where the
 * truth is 40%.
 *
 * Two halves, with very different confidence:
 *
 *  - **Whether prices include tax** comes from `shop.taxesIncluded`. Shopify
 *    knows this for certain, so the app should never ask.
 *  - **The rate itself** has no authoritative source in the Admin API. Shopify
 *    models tax as per-region rules that vary by product and destination, not
 *    as one number. So it is inferred from the shop's country, and the merchant
 *    is asked to confirm before the figures are presented as fact.
 *
 * Kept free of Prisma and the network so both halves can be tested directly.
 */

/**
 * Standard VAT/GST rates by country, as a **starting point for the merchant to
 * confirm** — not a tax lookup table.
 *
 * Reduced rates, regional variations and product-specific rules are all out of
 * scope: this only has to be close enough that a merchant recognises it and
 * clicks confirm. Rates do change, so treat a wrong entry here as a typo to fix
 * rather than a bug in the logic.
 */
const STANDARD_TAX_RATES: Record<string, number> = {
  // United Kingdom and Ireland
  GB: 20,
  IE: 23,
  // Eurozone and wider EU
  AT: 20,
  BE: 21,
  BG: 20,
  CY: 19,
  CZ: 21,
  DE: 19,
  DK: 25,
  EE: 24,
  ES: 21,
  FI: 25.5,
  FR: 20,
  GR: 24,
  HR: 25,
  HU: 27,
  IT: 22,
  LT: 21,
  LU: 17,
  LV: 21,
  MT: 18,
  NL: 21,
  PL: 23,
  PT: 23,
  RO: 21,
  SE: 25,
  SI: 22,
  SK: 23,
  // Rest of Europe
  CH: 8.1,
  IS: 24,
  NO: 25,
  TR: 20,
  // Asia-Pacific
  AU: 10,
  CN: 13,
  ID: 11,
  IN: 18,
  JP: 10,
  KR: 10,
  MY: 8,
  NZ: 15,
  PH: 12,
  SG: 9,
  TH: 7,
  VN: 10,
  // Americas, Middle East and Africa
  AE: 5,
  AR: 21,
  BR: 17,
  CL: 19,
  CO: 19,
  EG: 14,
  IL: 18,
  KE: 16,
  MX: 16,
  NG: 7.5,
  SA: 15,
  ZA: 15,
};

/**
 * The standard rate for a country, or null when we have no entry.
 *
 * Null is meaningfully different from zero: zero claims there is no tax, null
 * says we do not know and the merchant must tell us.
 */
export function standardTaxRateForCountry(
  countryCode: string | null | undefined,
): number | null {
  if (!countryCode) return null;
  const code = countryCode.trim().toUpperCase();
  return STANDARD_TAX_RATES[code] ?? null;
}

export interface ShopTaxProfile {
  /** Shopify's own answer to "do displayed prices include tax?". */
  taxesIncluded: boolean;
  countryCode: string | null;
  currencyCode: string | null;
}

export interface DetectedTaxDefaults {
  pricesIncludeTax: boolean;
  taxRatePct: number;
  currencyCode: string | null;
  countryCode: string | null;
  /**
   * True when the merchant genuinely needs to check the rate before trusting
   * any margin — i.e. prices include tax but we could not infer the rate.
   */
  needsRateConfirmation: boolean;
}

/**
 * Turns a shop profile into starting settings.
 *
 * Note the asymmetry: when prices *exclude* tax the rate is irrelevant to
 * margin — net revenue is simply the price — so it is forced to zero rather
 * than guessed. Storing a country's VAT rate on a US store that adds sales tax
 * at checkout would be a trap waiting for someone to later flip the
 * tax-inclusive switch.
 */
export function deriveTaxDefaults(
  profile: ShopTaxProfile,
): DetectedTaxDefaults {
  if (!profile.taxesIncluded) {
    return {
      pricesIncludeTax: false,
      taxRatePct: 0,
      currencyCode: profile.currencyCode,
      countryCode: profile.countryCode,
      needsRateConfirmation: false,
    };
  }

  const rate = standardTaxRateForCountry(profile.countryCode);

  return {
    pricesIncludeTax: true,
    // 0 is the safe fallback when unknown: it reports margin on the full price,
    // which is wrong but obviously so, and the banner says as much. Inventing a
    // rate would be wrong and invisible.
    taxRatePct: rate ?? 0,
    currencyCode: profile.currencyCode,
    countryCode: profile.countryCode,
    needsRateConfirmation: rate === null,
  };
}

/** A short human explanation of what was detected, for the onboarding banner. */
export function describeDetection(defaults: DetectedTaxDefaults): string {
  if (!defaults.pricesIncludeTax) {
    return "Your prices exclude tax, so margins are calculated on the full price.";
  }
  if (defaults.needsRateConfirmation) {
    return "Your prices include tax, but we could not work out your rate. Set it below or margins will be overstated.";
  }
  return `Your prices include tax at ${defaults.taxRatePct}%, which is the standard rate for your country.`;
}
