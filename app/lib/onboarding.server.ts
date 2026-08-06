import prisma from "../db.server";
import type { GraphQLClient } from "./catalog.server";
import {
  deriveTaxDefaults,
  type DetectedTaxDefaults,
  type ShopTaxProfile,
} from "./onboarding";

/**
 * Install-time detection of a shop's tax setup.
 *
 * Runs from the `afterAuth` hook so a merchant's very first look at the
 * dashboard already reflects how their store actually prices, rather than the
 * UK-shaped schema defaults.
 */

export const SHOP_TAX_PROFILE_QUERY = `#graphql
  query ShopTaxProfile {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
      taxesIncluded
      shopAddress {
        countryCodeV2
      }
    }
  }
`;

/** Reads the shop's tax and currency setup. Returns null if the call fails. */
export async function fetchShopTaxProfile(
  graphql: GraphQLClient,
): Promise<ShopTaxProfile | null> {
  try {
    const response = await graphql(SHOP_TAX_PROFILE_QUERY);
    const body = (await response.json()) as {
      data?: {
        shop?: {
          currencyCode?: string | null;
          taxesIncluded?: boolean | null;
          shopAddress?: { countryCodeV2?: string | null } | null;
        } | null;
      };
    };

    const shop = body.data?.shop;
    if (!shop || typeof shop.taxesIncluded !== "boolean") return null;

    return {
      taxesIncluded: shop.taxesIncluded,
      countryCode: shop.shopAddress?.countryCodeV2 ?? null,
      currencyCode: shop.currencyCode ?? null,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[onboarding] Could not read shop tax profile", error);
    return null;
  }
}

export interface ApplyDefaultsResult {
  applied: boolean;
  reason: "applied" | "already-onboarded" | "detection-failed";
  defaults: DetectedTaxDefaults | null;
}

/**
 * Seeds a shop's tax settings from what Shopify reports.
 *
 * Only ever writes before the merchant has confirmed. Once `onboardedAt` is
 * set, their choices are theirs — reinstalling the app must not quietly reset a
 * rate they deliberately changed, and `afterAuth` fires on every reauth, not
 * just the first install.
 */
export async function applyDetectedDefaults(
  shop: string,
  graphql: GraphQLClient,
): Promise<ApplyDefaultsResult> {
  const existing = await prisma.shopSettings.findUnique({
    where: { shop },
    select: { onboardedAt: true },
  });

  if (existing?.onboardedAt) {
    return { applied: false, reason: "already-onboarded", defaults: null };
  }

  const profile = await fetchShopTaxProfile(graphql);
  if (!profile) {
    // Leave the row alone; the dashboard banner still prompts the merchant, so
    // a failed detection degrades to "ask the human" rather than to bad data.
    return { applied: false, reason: "detection-failed", defaults: null };
  }

  const defaults = deriveTaxDefaults(profile);

  const data = {
    pricesIncludeTax: defaults.pricesIncludeTax,
    taxRatePct: defaults.taxRatePct,
    detectedCountryCode: defaults.countryCode,
    needsRateConfirmation: defaults.needsRateConfirmation,
    ...(defaults.currencyCode ? { currencyCode: defaults.currencyCode } : {}),
  };

  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });

  // eslint-disable-next-line no-console
  console.log(
    `[onboarding] ${shop}: taxesIncluded=${defaults.pricesIncludeTax} rate=${defaults.taxRatePct} country=${defaults.countryCode ?? "unknown"}`,
  );

  return { applied: true, reason: "applied", defaults };
}

/** Records that the merchant has checked the tax settings. */
export async function markOnboarded(shop: string) {
  return prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, onboardedAt: new Date(), needsRateConfirmation: false },
    update: { onboardedAt: new Date(), needsRateConfirmation: false },
  });
}
