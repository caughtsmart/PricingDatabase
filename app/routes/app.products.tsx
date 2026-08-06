import { useMemo, useState } from "react";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { formatMoney, formatPercent, statusLabel, statusTone } from "../lib/format";
import { buildRollup } from "../lib/rollup.server";
import type { MarginStatus } from "../lib/margin";
import { authenticate } from "../shopify.server";

/** Cap on rows sent to the browser, so a huge catalogue cannot hang the tab. */
const MAX_ROWS = 500;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const rollup = await buildRollup(session.shop);

  const sorted = [...rollup.lines].sort(
    (a, b) => a.margin.netMarginPct - b.margin.netMarginPct,
  );

  return {
    currencyCode: rollup.currencyCode,
    totalCount: sorted.length,
    truncated: sorted.length > MAX_ROWS,
    rows: sorted.slice(0, MAX_ROWS).map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      title: line.productTitle,
      variantTitle: line.variantTitle,
      sku: line.sku,
      vendor: line.vendor,
      price: line.price,
      landedUnitCost: line.margin.landedUnitCost,
      netProfit: line.margin.netProfit,
      netMarginPct: line.margin.netMarginPct,
      inventoryQuantity: line.inventoryQuantity,
      unitsSold: line.unitsSold,
      status: line.margin.status,
      hasCostData: line.margin.hasCostData,
    })),
  };
}

type Filter = "all" | "attention" | "missing";

export default function Products() {
  const data = useLoaderData<typeof loader>();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const money = (value: number) => formatMoney(value, data.currencyCode);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (filter === "attention") {
        const status: MarginStatus = row.status;
        if (status !== "loss" && status !== "critical") return false;
      }
      if (filter === "missing" && row.hasCostData) return false;

      if (!term) return true;
      return (
        row.title.toLowerCase().includes(term) ||
        (row.sku ?? "").toLowerCase().includes(term) ||
        (row.vendor ?? "").toLowerCase().includes(term)
      );
    });
  }, [data.rows, filter, search]);

  return (
    <s-page heading="Products">
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-search-field
            label="Search"
            placeholder="Product, SKU or vendor"
            value={search}
            onInput={(event) =>
              setSearch((event.target as HTMLInputElement).value)
            }
          />
          {/* onInput rather than onChange: React reserves onChange semantics
              for its own form elements, and these are custom elements. */}
          <s-select
            label="Show"
            value={filter}
            onInput={(event) =>
              setFilter((event.target as HTMLSelectElement).value as Filter)
            }
          >
            <s-option value="all">All variants</s-option>
            <s-option value="attention">Needs attention</s-option>
            <s-option value="missing">No cost recorded</s-option>
          </s-select>
        </s-stack>
        <s-paragraph>
          Showing {rows.length} of {data.totalCount} variants, worst margin
          first.
          {data.truncated
            ? ` Only the first ${MAX_ROWS} are listed — narrow the search to see more.`
            : ""}
        </s-paragraph>
      </s-section>

      <s-section>
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header>Product</s-table-header>
            <s-table-header>SKU</s-table-header>
            <s-table-header>Price</s-table-header>
            <s-table-header>Landed cost</s-table-header>
            <s-table-header>Profit</s-table-header>
            <s-table-header>Net margin</s-table-header>
            <s-table-header>Stock</s-table-header>
            <s-table-header>Sold 90d</s-table-header>
            <s-table-header>Status</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((row) => (
              <s-table-row key={row.variantId}>
                <s-table-cell>
                  <s-link href={`shopify://admin/products/${row.productId}`}>
                    {row.title}
                    {row.variantTitle && row.variantTitle !== "Default Title"
                      ? ` — ${row.variantTitle}`
                      : ""}
                  </s-link>
                </s-table-cell>
                <s-table-cell>{row.sku ?? "—"}</s-table-cell>
                <s-table-cell>{money(row.price)}</s-table-cell>
                <s-table-cell>
                  {row.hasCostData ? money(row.landedUnitCost) : "—"}
                </s-table-cell>
                <s-table-cell>
                  {row.hasCostData ? money(row.netProfit) : "—"}
                </s-table-cell>
                <s-table-cell>
                  {row.hasCostData ? formatPercent(row.netMarginPct) : "—"}
                </s-table-cell>
                <s-table-cell>{row.inventoryQuantity}</s-table-cell>
                <s-table-cell>{row.unitsSold}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={statusTone(row.status)}>
                    {statusLabel(row.status)}
                  </s-badge>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}
