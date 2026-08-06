import prisma from "../db.server";
import { toNumericId } from "./costs.server";

/**
 * Admin API access for a single product's margin data.
 *
 * Whole-catalogue reads live in `sync.server.ts` and go through Shopify's Bulk
 * Operations API instead; this module covers the per-product lookups the
 * product-page widget needs, where a direct query is the right tool.
 *
 * Every operation here is validated against the Shopify Admin schema.
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
