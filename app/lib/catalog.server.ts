import prisma from "../db.server";
import { toNumericId } from "./costs.server";

/**
 * Admin API access for catalogue data, plus the sync that caches it locally.
 *
 * Every operation here is validated against the Shopify Admin schema. The
 * dashboard never calls the Admin API directly — it reads `VariantSnapshot`,
 * because paging a whole catalogue on each page load would be both slow and a
 * fast route to a rate-limit ban.
 */

/** The subset of `admin.graphql` we depend on, so callers can pass a stub in tests. */
export type GraphQLClient = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export const PRODUCT_MARGIN_QUERY = `#graphql
  query ProductMarginData($id: ID!) {
    product(id: $id) {
      id
      title
      status
      vendor
      productType
      featuredMedia { preview { image { url } } }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          inventoryQuantity
          inventoryItem {
            id
            unitCost { amount currencyCode }
          }
        }
      }
    }
    shop {
      currencyCode
      taxesIncluded
    }
  }
`;

export const CATALOG_SYNC_QUERY = `#graphql
  query CatalogSync($cursor: String) {
    productVariants(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        sku
        price
        compareAtPrice
        inventoryQuantity
        inventoryItem { unitCost { amount } }
        product {
          id
          title
          vendor
          productType
          status
          featuredMedia { preview { image { url } } }
        }
      }
    }
  }
`;

export const SALES_SYNC_QUERY = `#graphql
  query SalesSync($cursor: String, $query: String!) {
    orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        createdAt
        lineItems(first: 100) {
          nodes {
            quantity
            variant { id }
          }
        }
      }
    }
  }
`;

export const UPDATE_UNIT_COST_MUTATION = `#graphql
  mutation UpdateUnitCost($id: ID!, $cost: Decimal!) {
    inventoryItemUpdate(id: $id, input: { cost: $cost }) {
      inventoryItem { id unitCost { amount } }
      userErrors { field message }
    }
  }
`;

export interface ProductVariantData {
  id: string;
  title: string | null;
  sku: string | null;
  price: number;
  compareAtPrice: number | null;
  inventoryQuantity: number;
  unitCost: number | null;
  inventoryItemId: string | null;
}

export interface ProductMarginData {
  productId: string;
  productTitle: string;
  status: string | null;
  vendor: string | null;
  productType: string | null;
  imageUrl: string | null;
  variants: ProductVariantData[];
  currencyCode: string;
  taxesIncluded: boolean;
}

function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reads one product with every variant's price and unit cost. */
export async function fetchProductMarginData(
  graphql: GraphQLClient,
  productId: string,
): Promise<ProductMarginData | null> {
  const response = await graphql(PRODUCT_MARGIN_QUERY, {
    variables: { id: productId },
  });
  const body = (await response.json()) as {
    data?: {
      product: {
        id: string;
        title: string;
        status: string | null;
        vendor: string | null;
        productType: string | null;
        featuredMedia: { preview: { image: { url: string } | null } | null } | null;
        variants: {
          nodes: Array<{
            id: string;
            title: string | null;
            sku: string | null;
            price: string;
            compareAtPrice: string | null;
            inventoryQuantity: number | null;
            inventoryItem: {
              id: string;
              unitCost: { amount: string } | null;
            } | null;
          }>;
        };
      } | null;
      shop: { currencyCode: string; taxesIncluded: boolean };
    };
  };

  const product = body.data?.product;
  if (!product) return null;

  return {
    productId: product.id,
    productTitle: product.title,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    imageUrl: product.featuredMedia?.preview?.image?.url ?? null,
    currencyCode: body.data?.shop.currencyCode ?? "GBP",
    taxesIncluded: body.data?.shop.taxesIncluded ?? true,
    variants: product.variants.nodes.map((variant) => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku,
      price: parseMoney(variant.price) ?? 0,
      compareAtPrice: parseMoney(variant.compareAtPrice),
      inventoryQuantity: variant.inventoryQuantity ?? 0,
      unitCost: parseMoney(variant.inventoryItem?.unitCost?.amount),
      inventoryItemId: variant.inventoryItem?.id ?? null,
    })),
  };
}

/** Writes Shopify's own "Cost per item" field. Returns any user errors. */
export async function updateUnitCost(
  graphql: GraphQLClient,
  inventoryItemId: string,
  cost: number,
): Promise<string[]> {
  const response = await graphql(UPDATE_UNIT_COST_MUTATION, {
    variables: { id: inventoryItemId, cost: cost.toFixed(2) },
  });
  const body = (await response.json()) as {
    data?: {
      inventoryItemUpdate: {
        userErrors: Array<{ field: string[] | null; message: string }>;
      } | null;
    };
  };
  return (
    body.data?.inventoryItemUpdate?.userErrors.map((error) => error.message) ??
    []
  );
}

/**
 * Hard ceiling on pages pulled in one sync.
 *
 * 200 pages x 100 variants = 20,000 variants. Beyond that a merchant needs the
 * Bulk Operations API rather than cursor paging; the sync reports how far it
 * got rather than silently truncating.
 */
const MAX_CATALOG_PAGES = 200;
const MAX_ORDER_PAGES = 100;

export interface SyncResult {
  variantsSynced: number;
  truncated: boolean;
  ordersScanned: number;
}

/**
 * Pulls the catalogue into `VariantSnapshot` and tallies recent unit sales.
 *
 * Runs as a full refresh rather than a delta: catalogue sizes that fit the page
 * cap are cheap to re-read, and it means a merchant who edits costs outside the
 * app is never left looking at stale margins.
 */
export async function syncCatalog(
  graphql: GraphQLClient,
  shop: string,
  options: { salesWindowDays?: number } = {},
): Promise<SyncResult> {
  const salesWindowDays = options.salesWindowDays ?? 90;

  const run = await prisma.syncRun.create({ data: { shop } });

  try {
    const rows: Array<{
      shop: string;
      variantId: string;
      productId: string;
      productTitle: string;
      variantTitle: string | null;
      sku: string | null;
      vendor: string | null;
      productType: string | null;
      status: string | null;
      imageUrl: string | null;
      price: number;
      compareAtPrice: number | null;
      unitCost: number | null;
      inventoryQuantity: number;
    }> = [];

    let cursor: string | null = null;
    let pages = 0;
    let truncated = false;

    do {
      const response: Response = await graphql(CATALOG_SYNC_QUERY, {
        variables: { cursor },
      });
      const body = (await response.json()) as {
        data?: {
          productVariants: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              id: string;
              title: string | null;
              sku: string | null;
              price: string;
              compareAtPrice: string | null;
              inventoryQuantity: number | null;
              inventoryItem: { unitCost: { amount: string } | null } | null;
              product: {
                id: string;
                title: string;
                vendor: string | null;
                productType: string | null;
                status: string | null;
                featuredMedia: {
                  preview: { image: { url: string } | null } | null;
                } | null;
              } | null;
            }>;
          };
        };
      };

      const page = body.data?.productVariants;
      if (!page) break;

      for (const variant of page.nodes) {
        if (!variant.product) continue;
        rows.push({
          shop,
          variantId: toNumericId(variant.id),
          productId: toNumericId(variant.product.id),
          productTitle: variant.product.title,
          variantTitle: variant.title,
          sku: variant.sku,
          vendor: variant.product.vendor,
          productType: variant.product.productType,
          status: variant.product.status,
          imageUrl: variant.product.featuredMedia?.preview?.image?.url ?? null,
          price: parseMoney(variant.price) ?? 0,
          compareAtPrice: parseMoney(variant.compareAtPrice),
          unitCost: parseMoney(variant.inventoryItem?.unitCost?.amount),
          inventoryQuantity: variant.inventoryQuantity ?? 0,
        });
      }

      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      pages += 1;

      if (cursor && pages >= MAX_CATALOG_PAGES) {
        truncated = true;
        break;
      }
    } while (cursor);

    const { unitsSold, ordersScanned } = await fetchUnitsSold(
      graphql,
      salesWindowDays,
    );

    // Replace wholesale inside a transaction so the dashboard never reads a
    // half-written catalogue.
    await prisma.$transaction([
      prisma.variantSnapshot.deleteMany({ where: { shop } }),
      prisma.variantSnapshot.createMany({
        data: rows.map((row) => ({
          ...row,
          unitsSold: unitsSold.get(row.variantId) ?? 0,
        })),
      }),
      prisma.shopSettings.upsert({
        where: { shop },
        create: { shop, lastSyncedAt: new Date() },
        update: { lastSyncedAt: new Date() },
      }),
      prisma.syncRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          status: "success",
          variantsSynced: rows.length,
        },
      }),
    ]);

    return { variantsSynced: rows.length, truncated, ordersScanned };
  } catch (error) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

/** Tallies units sold per variant over the trailing window. */
async function fetchUnitsSold(
  graphql: GraphQLClient,
  windowDays: number,
): Promise<{ unitsSold: Map<string, number>; ordersScanned: number }> {
  const unitsSold = new Map<string, number>();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const searchQuery = `created_at:>=${since.toISOString().slice(0, 10)}`;

  let cursor: string | null = null;
  let pages = 0;
  let ordersScanned = 0;

  do {
    const response: Response = await graphql(SALES_SYNC_QUERY, {
      variables: { cursor, query: searchQuery },
    });
    const body = (await response.json()) as {
      data?: {
        orders: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            lineItems: {
              nodes: Array<{
                quantity: number;
                variant: { id: string } | null;
              }>;
            };
          }>;
        };
      };
    };

    const page = body.data?.orders;
    if (!page) break;

    for (const order of page.nodes) {
      ordersScanned += 1;
      for (const item of order.lineItems.nodes) {
        if (!item.variant) continue;
        const id = toNumericId(item.variant.id);
        unitsSold.set(id, (unitsSold.get(id) ?? 0) + item.quantity);
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    pages += 1;
  } while (cursor && pages < MAX_ORDER_PAGES);

  return { unitsSold, ordersScanned };
}
