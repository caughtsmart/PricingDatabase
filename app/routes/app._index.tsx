import { useEffect } from "react";
import {
  Form,
  Link,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useRouteLoaderData,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import type { loader as appLoader } from "./app";

import type { GraphQLClient } from "../lib/catalog.server";
import { formatMoney, formatPercent, statusLabel, statusTone } from "../lib/format";
import { markOnboarded } from "../lib/onboarding.server";
import { breakdownByVendor, buildRollup } from "../lib/rollup.server";
import { cancelSync, getLatestSyncRun, startSync } from "../lib/sync.server";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [rollup, syncRun] = await Promise.all([
    buildRollup(session.shop),
    getLatestSyncRun(session.shop),
  ]);

  // Worst first: the merchant opens this page to find what is bleeding money,
  // not to admire the healthy lines.
  const attention = [...rollup.lines]
    .filter(
      (line) => line.margin.status === "loss" || line.margin.status === "critical",
    )
    .sort((a, b) => a.margin.netMarginPct - b.margin.netMarginPct)
    .slice(0, 10);

  const missingCost = rollup.lines
    .filter((line) => !line.margin.hasCostData)
    .slice(0, 10);

  return {
    totals: rollup.totals,
    currencyCode: rollup.currencyCode,
    onboarding: {
      confirmed: rollup.onboardedAt !== null,
      needsRateConfirmation: rollup.needsRateConfirmation,
      summary: rollup.detectionSummary,
    },
    lastSyncedAt: rollup.lastSyncedAt
      ? rollup.lastSyncedAt.toISOString()
      : null,
    targetMarginPct: rollup.targetMarginPct,
    syncRun: syncRun
      ? {
          id: syncRun.id,
          status: syncRun.status,
          stage: syncRun.stage,
          objectCount: syncRun.objectCount,
          variantsSynced: syncRun.variantsSynced,
          ordersScanned: syncRun.ordersScanned,
          errorMessage: syncRun.errorMessage,
        }
      : null,
    vendors: breakdownByVendor(rollup.lines).slice(0, 8),
    attention: attention.map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      title: line.productTitle,
      variantTitle: line.variantTitle,
      price: line.price,
      netMarginPct: line.margin.netMarginPct,
      netProfit: line.margin.netProfit,
      status: line.margin.status,
    })),
    missingCost: missingCost.map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      title: line.productTitle,
      variantTitle: line.variantTitle,
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const graphql = admin.graphql as GraphQLClient;

  if (String(formData.get("intent")) === "confirm-tax") {
    await markOnboarded(session.shop);
    return { ok: true, message: "Tax settings confirmed." };
  }

  if (String(formData.get("intent")) === "cancel") {
    const cancelled = await cancelSync(graphql, session.shop);
    return {
      ok: cancelled,
      message: cancelled ? "Sync cancelled." : "There was no sync to cancel.",
    };
  }

  // Returns as soon as Shopify accepts the bulk query — the import itself
  // happens in the background, driven by the finish webhook.
  const result = await startSync(graphql, session.shop);
  return { ok: result.started, message: result.message };
}

type SyncRunState = NonNullable<
  Awaited<ReturnType<typeof loader>>["syncRun"]
>;

const IN_FLIGHT_STATUSES = ["queued", "running", "ingesting"];

function syncProgressLabel(run: SyncRunState): string {
  const stage =
    run.stage === "orders" ? "Reading sales history" : "Reading catalogue";

  if (run.status === "queued") return "Waiting for Shopify to start the export…";
  if (run.status === "ingesting") {
    return run.stage === "orders"
      ? "Importing sales history…"
      : "Importing catalogue…";
  }
  return run.objectCount > 0
    ? `${stage}: ${run.objectCount.toLocaleString("en-GB")} records so far…`
    : `${stage}…`;
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  // Reuse the layout's billing lookup rather than querying Shopify again.
  const app = useRouteLoaderData<typeof appLoader>("routes/app");
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const syncing = navigation.state === "submitting";

  const syncInFlight = Boolean(
    data.syncRun && IN_FLIGHT_STATUSES.includes(data.syncRun.status),
  );

  // A sync finishes on a webhook, not in response to anything the browser did,
  // so the page has to ask. Polling only runs while something is actually in
  // flight, and stops as soon as it is not.
  useEffect(() => {
    if (!syncInFlight) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 4000);
    return () => clearInterval(timer);
  }, [syncInFlight, revalidator]);

  const money = (value: number) => formatMoney(value, data.currencyCode);
  const neverSynced = data.lastSyncedAt === null;

  // With enforcement on, an unsubscribed merchant is redirected before this
  // renders, so the prompt only appears while the app is running free.
  const showUpgradePrompt =
    app !== undefined && !app.subscription.active && !app.billingEnforced;

  return (
    <s-page heading="Margin dashboard">
      {/* Shown before anything else: an unconfirmed tax setup shifts every
          margin on the page, so the merchant should not read the figures as
          settled until they have checked it. */}
      {!data.onboarding.confirmed ? (
        <s-section>
          <s-banner
            tone={data.onboarding.needsRateConfirmation ? "warning" : "info"}
            heading="Check your tax setup"
          >
            <s-stack direction="block" gap="small-400">
              <s-paragraph>
                {data.onboarding.summary} Margins are provisional until you
                confirm this — getting it wrong shifts every figure here.
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <Form method="post">
                  <input type="hidden" name="intent" value="confirm-tax" />
                  <s-button variant="primary" type="submit">
                    That&rsquo;s right
                  </s-button>
                </Form>
                <Link to="/app/settings">Change it</Link>
              </s-stack>
            </s-stack>
          </s-banner>
        </s-section>
      ) : null}

      {showUpgradePrompt ? (
        <s-section>
          <s-banner tone="info" heading="You're on the free plan">
            <s-paragraph>
              Margin Lens is running without a subscription.{" "}
              <s-link href={app.planUrl} target="_top">
                See plans
              </s-link>
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      {app?.subscription.test ? (
        <s-section>
          <s-banner tone="warning" heading="Test charge">
            <s-paragraph>
              This shop is on a test subscription, so no money is changing hands.
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      <s-section>
        <s-stack direction="block" gap="small-400">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-paragraph>
              {neverSynced
                ? "Run a sync to pull your catalogue in and start seeing margins."
                : `Last synced ${new Date(data.lastSyncedAt!).toLocaleString("en-GB")}.`}
            </s-paragraph>
            <Form method="post">
              <s-button
                variant="primary"
                type="submit"
                disabled={syncing || syncInFlight}
              >
                {syncInFlight ? "Syncing…" : "Sync catalogue"}
              </s-button>
            </Form>
            {syncInFlight ? (
              <Form method="post">
                <input type="hidden" name="intent" value="cancel" />
                <s-button variant="secondary" type="submit">
                  Cancel
                </s-button>
              </Form>
            ) : null}
          </s-stack>

          {syncInFlight ? (
            <s-stack direction="inline" gap="small-400" alignItems="center">
              <s-spinner />
              <s-text color="subdued">{syncProgressLabel(data.syncRun!)}</s-text>
            </s-stack>
          ) : null}

          {data.syncRun?.status === "error" ? (
            <s-banner tone="critical" heading="Last sync failed">
              <s-paragraph>
                {data.syncRun.errorMessage ?? "Something went wrong."}
              </s-paragraph>
            </s-banner>
          ) : null}

          {data.syncRun?.status === "success" && data.syncRun.errorMessage ? (
            <s-banner tone="warning" heading="Partly synced">
              <s-paragraph>{data.syncRun.errorMessage}</s-paragraph>
            </s-banner>
          ) : null}
        </s-stack>
      </s-section>

      {neverSynced ? null : (
        <s-section heading="Overview">
          <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
            <Metric
              label="Average net margin"
              value={formatPercent(data.totals.averageNetMarginPct)}
              caption={`Target ${formatPercent(data.targetMarginPct)} · weighted by revenue`}
            />
            <Metric
              label="Profit in stock"
              value={money(data.totals.potentialProfit)}
              caption={`${money(data.totals.stockCostValue)} tied up at cost`}
            />
            <Metric
              label="Realised profit (90 days)"
              value={money(data.totals.realisedProfit)}
              caption={`${formatPercent(data.totals.realisedMarginPct)} of ${money(data.totals.realisedRevenue)}`}
            />
            <Metric
              label="Needs attention"
              value={String(data.totals.lossCount + data.totals.criticalCount)}
              caption={`${data.totals.missingCostCount} with no cost recorded`}
            />
          </s-grid>
        </s-section>
      )}

      {data.totals.missingCostCount > 0 ? (
        <s-section>
          <s-banner tone="warning" heading="Some variants have no cost">
            <s-paragraph>
              {data.totals.missingCostCount} of {data.totals.variantCount}{" "}
              variants have no cost per item, so they are excluded from the
              average margin. Set a cost on the product page to include them.
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      {data.attention.length > 0 ? (
        <s-section heading="Losing money or close to it">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Price</s-table-header>
              <s-table-header>Net margin</s-table-header>
              <s-table-header>Profit per unit</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.attention.map((line) => (
                <s-table-row key={line.variantId}>
                  <s-table-cell>
                    <s-link href={`shopify://admin/products/${line.productId}`}>
                      {line.title}
                      {line.variantTitle && line.variantTitle !== "Default Title"
                        ? ` — ${line.variantTitle}`
                        : ""}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{money(line.price)}</s-table-cell>
                  <s-table-cell>{formatPercent(line.netMarginPct)}</s-table-cell>
                  <s-table-cell>{money(line.netProfit)}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(line.status)}>
                      {statusLabel(line.status)}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}

      {data.vendors.length > 0 ? (
        <s-section heading="By vendor">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Vendor</s-table-header>
              <s-table-header>Variants</s-table-header>
              <s-table-header>Avg net margin</s-table-header>
              <s-table-header>Profit in stock</s-table-header>
              <s-table-header>Realised (90d)</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.vendors.map((vendor) => (
                <s-table-row key={vendor.vendor}>
                  <s-table-cell>{vendor.vendor}</s-table-cell>
                  <s-table-cell>{vendor.variantCount}</s-table-cell>
                  <s-table-cell>
                    {formatPercent(vendor.averageNetMarginPct)}
                  </s-table-cell>
                  <s-table-cell>{money(vendor.potentialProfit)}</s-table-cell>
                  <s-table-cell>{money(vendor.realisedProfit)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}

      {data.missingCost.length > 0 ? (
        <s-section heading="No cost recorded">
          <s-unordered-list>
            {data.missingCost.map((line) => (
              <s-list-item key={line.variantId}>
                <s-link href={`shopify://admin/products/${line.productId}`}>
                  {line.title}
                  {line.variantTitle && line.variantTitle !== "Default Title"
                    ? ` — ${line.variantTitle}`
                    : ""}
                </s-link>
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-section>
      ) : null}

      <s-section>
        <s-stack direction="inline" gap="base">
          <Link to="/app/products">See every product</Link>
          <Link to="/app/settings">Adjust cost rules</Link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function Metric({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-400">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        <s-text color="subdued">{caption}</s-text>
      </s-stack>
    </s-box>
  );
}
