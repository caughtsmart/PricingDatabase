import type { GraphQLClient } from "./catalog.server";

/**
 * Billing via **Shopify App Pricing** (formerly Managed Pricing).
 *
 * Plans are defined in the Partner Dashboard app listing rather than in code,
 * and Shopify hosts the plan selection page, handles the charge, trials,
 * proration and price changes. That is why there is no `billing` block in
 * `shopify.server.ts` and no Billing API mutation anywhere in this file — using
 * both models at once is not supported.
 *
 * What the app still has to do is exactly two things:
 *
 *  1. Know whether the current shop has an active subscription.
 *  2. Send merchants to the hosted plan page when they need one.
 *
 * ### On verifying the subscription
 *
 * Shopify's App Pricing docs point at the Partner API's Active Subscription
 * endpoint. That is the right call for org-wide reporting, but it needs an
 * organisation-level Partner API token, which an embedded per-shop request does
 * not have. `currentAppInstallation.activeSubscriptions` on the Admin API
 * answers the same question for *this* shop using the session we already hold,
 * and App Pricing subscriptions appear there like any other. That keeps the
 * check credential-free and scoped to the merchant in front of us.
 *
 * If you later need subscription state that survives uninstall, or a history of
 * billing events, that is the point at which the Partner API earns its keep.
 */

/**
 * Must match `handle` in shopify.app.toml — it forms part of the plan page URL.
 * Overridable by env so a differently-handled staging app still links correctly.
 */
export const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "margin-lens";

export const ACTIVE_SUBSCRIPTION_QUERY = `#graphql
  query ActiveSubscription {
    currentAppInstallation {
      id
      activeSubscriptions {
        id
        name
        status
        test
        trialDays
        currentPeriodEnd
        createdAt
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                interval
                price { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

export interface SubscriptionStatus {
  active: boolean;
  planName: string | null;
  status: string | null;
  /** True for development-store and Partner test charges — no real money. */
  test: boolean;
  trialDays: number | null;
  currentPeriodEnd: string | null;
  price: { amount: string; currencyCode: string; interval: string } | null;
}

export const NO_SUBSCRIPTION: SubscriptionStatus = {
  active: false,
  planName: null,
  status: null,
  test: false,
  trialDays: null,
  currentPeriodEnd: null,
  price: null,
};

interface RawSubscription {
  id: string;
  name: string;
  status: string;
  test: boolean;
  trialDays: number | null;
  currentPeriodEnd: string | null;
  createdAt: string;
  lineItems?: Array<{
    plan?: {
      pricingDetails?: {
        __typename?: string;
        interval?: string;
        price?: { amount: string; currencyCode: string };
      };
    };
  }>;
}

/**
 * Turns "cool-shop.myshopify.com" into "cool-shop".
 *
 * Tolerates a bare handle, a protocol, and a trailing slash, because this value
 * arrives from sessions, webhooks and query strings alike.
 */
export function storeHandleFromShopDomain(shop: string): string {
  return shop
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .split("/")[0]
    .replace(/\.myshopify\.com$/i, "");
}

/** The Shopify-hosted plan selection page for this app and shop. */
export function planSelectionUrl(shop: string, appHandle = APP_HANDLE): string {
  const store = storeHandleFromShopDomain(shop);
  return `https://admin.shopify.com/store/${store}/charges/${appHandle}/pricing_plans`;
}

/**
 * Picks the subscription to report on.
 *
 * `activeSubscriptions` normally returns at most one, but it is a list, so
 * prefer an explicitly ACTIVE one and fall back to the newest rather than
 * trusting position.
 */
export function pickActiveSubscription(
  subscriptions: RawSubscription[],
): RawSubscription | null {
  if (!subscriptions.length) return null;

  const active = subscriptions.filter(
    (subscription) => subscription.status?.toUpperCase() === "ACTIVE",
  );
  const pool = active.length ? active : subscriptions;

  return [...pool].sort((a, b) => {
    const left = Date.parse(a.createdAt ?? "");
    const right = Date.parse(b.createdAt ?? "");
    if (Number.isNaN(left) || Number.isNaN(right)) return 0;
    return right - left;
  })[0];
}

export function toSubscriptionStatus(
  subscription: RawSubscription | null,
): SubscriptionStatus {
  if (!subscription) return { ...NO_SUBSCRIPTION };

  const pricing = subscription.lineItems?.find(
    (item) => item.plan?.pricingDetails?.price,
  )?.plan?.pricingDetails;

  return {
    active: subscription.status?.toUpperCase() === "ACTIVE",
    planName: subscription.name ?? null,
    status: subscription.status ?? null,
    test: Boolean(subscription.test),
    trialDays: subscription.trialDays ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd ?? null,
    price:
      pricing?.price && pricing.interval
        ? {
            amount: pricing.price.amount,
            currencyCode: pricing.price.currencyCode,
            interval: pricing.interval,
          }
        : null,
  };
}

/**
 * Whether a missing subscription should block access.
 *
 * Off by default and switched on with `BILLING_ENFORCED=true`. This matters:
 * plans live in the Partner Dashboard, so until they are configured there is no
 * plan page to send anyone to, and enforcing would lock the app — including
 * during development — behind a page that cannot resolve. Ship free, configure
 * plans, then flip this.
 */
export function isBillingEnforced(): boolean {
  return process.env.BILLING_ENFORCED === "true";
}

/** Reads the current shop's subscription. Never throws — billing must not 500 the app. */
export async function getSubscriptionStatus(
  graphql: GraphQLClient,
): Promise<SubscriptionStatus> {
  try {
    const response = await graphql(ACTIVE_SUBSCRIPTION_QUERY);
    const body = (await response.json()) as {
      data?: {
        currentAppInstallation?: {
          activeSubscriptions?: RawSubscription[];
        } | null;
      };
    };

    const subscriptions =
      body.data?.currentAppInstallation?.activeSubscriptions ?? [];
    return toSubscriptionStatus(pickActiveSubscription(subscriptions));
  } catch (error) {
    // A billing lookup failing is not a reason to take the app down. Report no
    // subscription; enforcement is opt-in, so the default outcome is a banner
    // rather than a lockout.
    // eslint-disable-next-line no-console
    console.error("[billing] Could not read subscription status", error);
    return { ...NO_SUBSCRIPTION };
  }
}
