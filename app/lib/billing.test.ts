import { describe, expect, it } from "vitest";

import {
  pickActiveSubscription,
  planSelectionUrl,
  storeHandleFromShopDomain,
  toSubscriptionStatus,
} from "./billing.server";

describe("storeHandleFromShopDomain", () => {
  it("strips the myshopify suffix", () => {
    expect(storeHandleFromShopDomain("cool-shop.myshopify.com")).toBe("cool-shop");
  });

  it("tolerates a protocol, trailing slash and path", () => {
    expect(storeHandleFromShopDomain("https://cool-shop.myshopify.com/")).toBe(
      "cool-shop",
    );
    expect(
      storeHandleFromShopDomain("https://cool-shop.myshopify.com/admin"),
    ).toBe("cool-shop");
  });

  it("passes a bare handle straight through", () => {
    expect(storeHandleFromShopDomain("cool-shop")).toBe("cool-shop");
  });

  it("is case-insensitive about the suffix", () => {
    expect(storeHandleFromShopDomain("Cool-Shop.MyShopify.COM")).toBe("Cool-Shop");
  });
});

describe("planSelectionUrl", () => {
  it("builds the hosted plan page from store and app handle", () => {
    expect(planSelectionUrl("orcs-bazaar.myshopify.com", "cogspilot")).toBe(
      "https://admin.shopify.com/store/orcs-bazaar/charges/cogspilot/pricing_plans",
    );
  });
});

describe("pickActiveSubscription", () => {
  const sub = (
    id: string,
    status: string,
    createdAt: string,
  ) => ({
    id,
    name: `Plan ${id}`,
    status,
    test: false,
    trialDays: 0,
    currentPeriodEnd: null,
    createdAt,
  });

  it("returns null with no subscriptions", () => {
    expect(pickActiveSubscription([])).toBeNull();
  });

  it("prefers an ACTIVE subscription over a stale one", () => {
    const picked = pickActiveSubscription([
      sub("old", "CANCELLED", "2026-05-01T00:00:00Z"),
      sub("live", "ACTIVE", "2026-01-01T00:00:00Z"),
    ]);
    expect(picked?.id).toBe("live");
  });

  it("takes the newest when several are active", () => {
    const picked = pickActiveSubscription([
      sub("older", "ACTIVE", "2026-01-01T00:00:00Z"),
      sub("newer", "ACTIVE", "2026-06-01T00:00:00Z"),
    ]);
    expect(picked?.id).toBe("newer");
  });

  it("falls back to the newest when none are active", () => {
    const picked = pickActiveSubscription([
      sub("a", "EXPIRED", "2026-01-01T00:00:00Z"),
      sub("b", "FROZEN", "2026-06-01T00:00:00Z"),
    ]);
    expect(picked?.id).toBe("b");
  });
});

describe("toSubscriptionStatus", () => {
  it("reports no subscription for null", () => {
    const status = toSubscriptionStatus(null);
    expect(status.active).toBe(false);
    expect(status.planName).toBeNull();
    expect(status.price).toBeNull();
  });

  it("marks only ACTIVE as active", () => {
    const base = {
      id: "1",
      name: "Pro",
      test: false,
      trialDays: 14,
      currentPeriodEnd: "2026-09-01T00:00:00Z",
      createdAt: "2026-08-01T00:00:00Z",
    };

    expect(toSubscriptionStatus({ ...base, status: "ACTIVE" }).active).toBe(true);
    expect(toSubscriptionStatus({ ...base, status: "FROZEN" }).active).toBe(false);
    expect(toSubscriptionStatus({ ...base, status: "PENDING" }).active).toBe(false);
  });

  it("extracts recurring price details when present", () => {
    const status = toSubscriptionStatus({
      id: "1",
      name: "Pro",
      status: "ACTIVE",
      test: true,
      trialDays: 14,
      currentPeriodEnd: null,
      createdAt: "2026-08-01T00:00:00Z",
      lineItems: [
        {
          plan: {
            pricingDetails: {
              __typename: "AppRecurringPricing",
              interval: "EVERY_30_DAYS",
              price: { amount: "19.00", currencyCode: "GBP" },
            },
          },
        },
      ],
    });

    expect(status.price).toEqual({
      amount: "19.00",
      currencyCode: "GBP",
      interval: "EVERY_30_DAYS",
    });
    expect(status.test).toBe(true);
    expect(status.trialDays).toBe(14);
  });

  it("survives a usage-pricing line item with no recurring price", () => {
    const status = toSubscriptionStatus({
      id: "1",
      name: "Usage",
      status: "ACTIVE",
      test: false,
      trialDays: null,
      currentPeriodEnd: null,
      createdAt: "2026-08-01T00:00:00Z",
      lineItems: [{ plan: { pricingDetails: { __typename: "AppUsagePricing" } } }],
    });

    expect(status.active).toBe(true);
    expect(status.price).toBeNull();
  });
});
