import { describe, expect, it } from "vitest";

import { tallySales, toSnapshotRow } from "./sync.server";

describe("toSnapshotRow", () => {
  const variantLine = {
    id: "gid://shopify/ProductVariant/456",
    title: "Large",
    sku: "WIDGET-L",
    price: "24.99",
    compareAtPrice: "29.99",
    inventoryQuantity: 12,
    inventoryItem: { unitCost: { amount: "10.50" } },
    product: {
      id: "gid://shopify/Product/123",
      title: "Widget",
      vendor: "Acme",
      productType: "Gadgets",
      status: "ACTIVE",
      featuredMedia: { preview: { image: { url: "https://cdn/img.png" } } },
    },
  };

  it("flattens a bulk variant record into a snapshot row", () => {
    const row = toSnapshotRow(variantLine)!;

    expect(row.variantId).toBe("456");
    expect(row.productId).toBe("123");
    expect(row.productTitle).toBe("Widget");
    expect(row.price).toBe(24.99);
    expect(row.compareAtPrice).toBe(29.99);
    expect(row.unitCost).toBe(10.5);
    expect(row.inventoryQuantity).toBe(12);
    expect(row.imageUrl).toBe("https://cdn/img.png");
  });

  it("keeps a null unit cost null rather than defaulting it to zero", () => {
    // A zero here would silently claim 100% margin on an uncosted variant.
    const row = toSnapshotRow({ ...variantLine, inventoryItem: null })!;
    expect(row.unitCost).toBeNull();
  });

  it("treats a missing compare-at price as null", () => {
    const row = toSnapshotRow({ ...variantLine, compareAtPrice: null })!;
    expect(row.compareAtPrice).toBeNull();
  });

  it("defaults a missing inventory quantity to zero", () => {
    const row = toSnapshotRow({ ...variantLine, inventoryQuantity: null })!;
    expect(row.inventoryQuantity).toBe(0);
  });

  it("rejects records that are not variant lines", () => {
    // Bulk output interleaves record types; anything without a product is not
    // something this ingest can use.
    expect(toSnapshotRow({ id: "gid://shopify/Product/1" })).toBeNull();
    expect(
      toSnapshotRow({ id: "gid://shopify/ProductVariant/1", product: null }),
    ).toBeNull();
  });
});

describe("tallySales", () => {
  it("sums quantities per variant across separate line-item records", () => {
    // Line items arrive as their own JSONL records with a __parentId.
    const { unitsSold } = tallySales([
      { id: "gid://shopify/Order/1", createdAt: "2026-08-01T00:00:00Z" },
      {
        quantity: 2,
        variant: { id: "gid://shopify/ProductVariant/10" },
        __parentId: "gid://shopify/Order/1",
      },
      {
        quantity: 3,
        variant: { id: "gid://shopify/ProductVariant/10" },
        __parentId: "gid://shopify/Order/2",
      },
      {
        quantity: 1,
        variant: { id: "gid://shopify/ProductVariant/20" },
        __parentId: "gid://shopify/Order/2",
      },
    ]);

    expect(unitsSold.get("10")).toBe(5);
    expect(unitsSold.get("20")).toBe(1);
  });

  it("counts root order records without double-counting line items", () => {
    const { ordersScanned } = tallySales([
      { id: "gid://shopify/Order/1" },
      { quantity: 1, variant: { id: "gid://shopify/ProductVariant/10" }, __parentId: "gid://shopify/Order/1" },
      { id: "gid://shopify/Order/2" },
      { quantity: 1, variant: { id: "gid://shopify/ProductVariant/10" }, __parentId: "gid://shopify/Order/2" },
    ]);

    expect(ordersScanned).toBe(2);
  });

  it("ignores line items whose variant has been deleted", () => {
    const { unitsSold } = tallySales([
      { quantity: 5, variant: null, __parentId: "gid://shopify/Order/1" },
      {
        quantity: 2,
        variant: { id: "gid://shopify/ProductVariant/10" },
        __parentId: "gid://shopify/Order/1",
      },
    ]);

    expect(unitsSold.size).toBe(1);
    expect(unitsSold.get("10")).toBe(2);
  });

  it("returns empty totals for an empty export", () => {
    const { unitsSold, ordersScanned } = tallySales([]);
    expect(unitsSold.size).toBe(0);
    expect(ordersScanned).toBe(0);
  });
});
