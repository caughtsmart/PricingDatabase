import { Form, Link, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { syncCatalog, type GraphQLClient } from "../lib/catalog.server";
import { formatMoney, formatPercent, statusLabel, statusTone } from "../lib/format";
import { breakdownByVendor, buildRollup } from "../lib/rollup.server";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const rollup = await buildRollup(session.shop);

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
    lastSyncedAt: rollup.lastSyncedAt
      ? rollup.lastSyncedAt.toISOString()
      : null,
    targetMarginPct: rollup.targetMarginPct,
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

  try {
    const result = await syncCatalog(
      admin.graphql as GraphQLClient,
      session.shop,
    );
    return {
      ok: true,
      message: result.truncated
        ? `Synced the first ${result.variantsSynced} variants. This catalogue is large enough to need a bulk import — everything beyond that limit was not included.`
        : `Synced ${result.variantsSynced} variants across ${result.ordersScanned} recent orders.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Sync failed.",
    };
  }
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const syncing = navigation.state === "submitting";

  const money = (value: number) => formatMoney(value, data.currencyCode);
  const neverSynced = data.lastSyncedAt === null;

  return (
    <s-page heading="Margin dashboard">
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-paragraph>
            {neverSynced
              ? "Run a sync to pull your catalogue in and start seeing margins."
              : `Last synced ${new Date(data.lastSyncedAt!).toLocaleString("en-GB")}.`}
          </s-paragraph>
          <Form method="post">
            <s-button variant="primary" type="submit" disabled={syncing}>
              {syncing ? "Syncing…" : "Sync catalogue"}
            </s-button>
          </Form>
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
