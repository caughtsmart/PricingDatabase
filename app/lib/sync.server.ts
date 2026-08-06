import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { logger } from "../monitoring.server";
import type { AutoSyncCandidate } from "./autosync";
import {
  BulkOperationError,
  CATALOG_BULK_QUERY,
  cancelBulkOperation,
  downloadJsonl,
  getBulkOperation,
  ordersBulkQuery,
  startBulkQuery,
} from "./bulk.server";
import type { GraphQLClient } from "./catalog.server";
import { toNumericId } from "./costs.server";

/**
 * The catalogue sync state machine.
 *
 * A sync used to run inline in the dashboard's action, paging the Admin API and
 * holding the HTTP request open for its whole duration. That capped the
 * catalogue at 20,000 variants and timed out on large stores. It now runs as
 * two chained Shopify bulk operations driven by webhooks and a job queue, so
 * the button returns immediately and there is no page cap.
 *
 *   startSync()  submits the catalogue bulk query, returns at once
 *   Shopify      runs it, then sends `bulk_operations/finish`
 *   webhook      matches the run and enqueues an ingest job
 *   worker       downloads the JSONL, upserts, then submits the orders query
 *   webhook      fires again; the worker ingests sales and finalises the run
 *
 * Catalogue and orders are sequential rather than parallel because Shopify
 * permits only one bulk *query* per shop at a time.
 */

/** Rows written per statement. 18 columns x 400 keeps us well inside Postgres' parameter limit. */
const UPSERT_BATCH_SIZE = 400;

const DEFAULT_SALES_WINDOW_DAYS = 90;

export type SyncStage = "catalog" | "orders";

export interface StartSyncResult {
  syncRunId: string;
  started: boolean;
  message: string;
}

function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A sync that is still in flight, if any. */
export async function getActiveSyncRun(shop: string) {
  return prisma.syncRun.findFirst({
    where: { shop, status: { in: ["queued", "running", "ingesting"] } },
    orderBy: { startedAt: "desc" },
  });
}

export async function getLatestSyncRun(shop: string) {
  return prisma.syncRun.findFirst({
    where: { shop },
    orderBy: { startedAt: "desc" },
  });
}

/**
 * Kicks off a sync and returns immediately.
 *
 * Refuses to start a second concurrent run: Shopify would reject the bulk query
 * anyway, and two runs would fight over the `lastSeenSyncId` sweep and delete
 * each other's rows.
 */
export async function startSync(
  graphql: GraphQLClient,
  shop: string,
): Promise<StartSyncResult> {
  const active = await getActiveSyncRun(shop);
  if (active) {
    return {
      syncRunId: active.id,
      started: false,
      message: "A sync is already running.",
    };
  }

  const run = await prisma.syncRun.create({
    data: { shop, status: "queued", stage: "catalog" },
  });

  try {
    const bulkOperationId = await startBulkQuery(graphql, CATALOG_BULK_QUERY);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: "running", bulkOperationId },
    });

    return {
      syncRunId: run.id,
      started: true,
      message: "Sync started. This runs in the background.",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not start the sync.";
    await failRun(run.id, message, error);
    return { syncRunId: run.id, started: false, message };
  }
}

async function failRun(syncRunId: string, message: string, error?: unknown) {
  // Logged as well as stored. SyncRun.errorMessage is only visible to a
  // merchant who happens to open the dashboard; a sync that fails at 03:00
  // needs to reach whoever operates the app, not just the shop it belongs to.
  logger.error("Sync run failed", { syncRunId, detail: message, error });

  await prisma.syncRun.update({
    where: { id: syncRunId },
    data: { status: "error", errorMessage: message, finishedAt: new Date() },
  });
}

/** Finds the run awaiting a given bulk operation, so a finish webhook can be routed. */
export async function findRunByBulkOperation(
  shop: string,
  bulkOperationId: string,
) {
  return prisma.syncRun.findFirst({
    where: { shop, bulkOperationId, status: { in: ["running", "ingesting"] } },
  });
}

/**
 * Processes whichever stage a run is currently waiting on.
 *
 * Called from the job queue, never from a request. Safe to run more than once
 * for the same run: ingestion is an upsert keyed on (shop, variantId), and the
 * final sweep is scoped to this run's id.
 */
export async function processSyncRun(
  graphql: GraphQLClient,
  shop: string,
  syncRunId: string,
): Promise<void> {
  const run = await prisma.syncRun.findUnique({ where: { id: syncRunId } });
  if (!run || run.shop !== shop) return;
  if (run.status === "success" || run.status === "error") return;
  if (!run.bulkOperationId) {
    await failRun(syncRunId, "Sync had no bulk operation to read.");
    return;
  }

  const operation = await getBulkOperation(graphql, run.bulkOperationId);
  if (!operation) {
    await failRun(syncRunId, "Bulk operation could not be found.");
    return;
  }

  if (operation.status !== "COMPLETED") {
    await failRun(
      syncRunId,
      `Bulk operation ${operation.status.toLowerCase()}${
        operation.errorCode ? ` (${operation.errorCode})` : ""
      }.`,
    );
    return;
  }

  // A completed operation that matched nothing has no file at all — a brand new
  // store with no products, for instance. That is a success with zero rows, not
  // a failure.
  const url = operation.url ?? operation.partialDataUrl;

  await prisma.syncRun.update({
    where: { id: syncRunId },
    data: { status: "ingesting", objectCount: operation.objectCount },
  });

  try {
    if (run.stage === "catalog") {
      const variantsSynced = url
        ? await ingestCatalog(shop, syncRunId, url)
        : 0;

      // Sweep rows this run did not touch: products deleted in Shopify since
      // the last sync. Scoped to this run's id, so a concurrent write cannot
      // remove rows it should not.
      await prisma.variantSnapshot.deleteMany({
        where: { shop, NOT: { lastSeenSyncId: syncRunId } },
      });

      await prisma.syncRun.update({
        where: { id: syncRunId },
        data: { variantsSynced },
      });

      await startOrdersStage(graphql, syncRunId);
      return;
    }

    const ordersScanned = url ? await ingestOrders(shop, url) : 0;

    await prisma.$transaction([
      prisma.syncRun.update({
        where: { id: syncRunId },
        data: { status: "success", ordersScanned, finishedAt: new Date() },
      }),
      prisma.shopSettings.upsert({
        where: { shop },
        create: { shop, lastSyncedAt: new Date() },
        update: { lastSyncedAt: new Date() },
      }),
    ]);
  } catch (error) {
    await failRun(
      syncRunId,
      error instanceof Error ? error.message : "Sync failed during ingest.",
      error,
    );
    throw error;
  }
}

/**
 * Moves a run on to its sales stage.
 *
 * A failure here leaves the catalogue already imported, so the run is marked
 * successful with a note rather than failed — losing correct product margins
 * because the sales half stumbled would be the wrong trade.
 */
async function startOrdersStage(graphql: GraphQLClient, syncRunId: string) {
  try {
    const bulkOperationId = await startBulkQuery(
      graphql,
      ordersBulkQuery(DEFAULT_SALES_WINDOW_DAYS),
    );
    await prisma.syncRun.update({
      where: { id: syncRunId },
      data: { stage: "orders", status: "running", bulkOperationId },
    });
  } catch (error) {
    const detail =
      error instanceof BulkOperationError || error instanceof Error
        ? error.message
        : "unknown error";
    // Not a failed run — the catalogue is already in. Still worth a warning,
    // because a shop silently missing realised margin looks like a data bug to
    // the merchant.
    logger.warn("Sales history stage could not start", { syncRunId, error });

    await prisma.syncRun.update({
      where: { id: syncRunId },
      data: {
        status: "success",
        finishedAt: new Date(),
        errorMessage: `Catalogue synced, but sales history could not be read: ${detail}`,
      },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Ingestion                                                                  */
/* -------------------------------------------------------------------------- */

interface CatalogLine {
  id: string;
  title?: string | null;
  sku?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  inventoryQuantity?: number | null;
  inventoryItem?: { unitCost?: { amount?: string } | null } | null;
  product?: {
    id: string;
    title?: string | null;
    vendor?: string | null;
    productType?: string | null;
    status?: string | null;
    featuredMedia?: { preview?: { image?: { url?: string } | null } | null } | null;
  } | null;
  __parentId?: string;
}

interface SnapshotRow {
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
}

export function toSnapshotRow(line: CatalogLine): SnapshotRow | null {
  // Bulk output interleaves record types; anything without a product is not a
  // variant line we can use.
  if (!line?.id || !line.product?.id) return null;

  return {
    variantId: toNumericId(line.id),
    productId: toNumericId(line.product.id),
    productTitle: line.product.title ?? "",
    variantTitle: line.title ?? null,
    sku: line.sku ?? null,
    vendor: line.product.vendor ?? null,
    productType: line.product.productType ?? null,
    status: line.product.status ?? null,
    imageUrl: line.product.featuredMedia?.preview?.image?.url ?? null,
    price: parseMoney(line.price) ?? 0,
    compareAtPrice: parseMoney(line.compareAtPrice),
    unitCost: parseMoney(line.inventoryItem?.unitCost?.amount),
    inventoryQuantity: line.inventoryQuantity ?? 0,
  };
}

async function upsertSnapshotBatch(
  shop: string,
  syncRunId: string,
  rows: SnapshotRow[],
) {
  if (!rows.length) return;

  // Explicit casts keep Postgres from complaining that a float8 parameter is
  // being written into a numeric column.
  const values = rows.map(
    (row) => Prisma.sql`(
      ${randomUUID()},
      ${shop},
      ${row.variantId},
      ${row.productId},
      ${row.productTitle},
      ${row.variantTitle},
      ${row.sku},
      ${row.vendor},
      ${row.productType},
      ${row.status},
      ${row.imageUrl},
      CAST(${row.price} AS DECIMAL(12,4)),
      CAST(${row.compareAtPrice} AS DECIMAL(12,4)),
      CAST(${row.unitCost} AS DECIMAL(12,4)),
      ${row.inventoryQuantity},
      0,
      ${syncRunId},
      NOW()
    )`,
  );

  await prisma.$executeRaw`
    INSERT INTO "VariantSnapshot" (
      "id", "shop", "variantId", "productId", "productTitle", "variantTitle",
      "sku", "vendor", "productType", "status", "imageUrl", "price",
      "compareAtPrice", "unitCost", "inventoryQuantity", "unitsSold",
      "lastSeenSyncId", "syncedAt"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("shop", "variantId") DO UPDATE SET
      "productId" = EXCLUDED."productId",
      "productTitle" = EXCLUDED."productTitle",
      "variantTitle" = EXCLUDED."variantTitle",
      "sku" = EXCLUDED."sku",
      "vendor" = EXCLUDED."vendor",
      "productType" = EXCLUDED."productType",
      "status" = EXCLUDED."status",
      "imageUrl" = EXCLUDED."imageUrl",
      "price" = EXCLUDED."price",
      "compareAtPrice" = EXCLUDED."compareAtPrice",
      "unitCost" = EXCLUDED."unitCost",
      "inventoryQuantity" = EXCLUDED."inventoryQuantity",
      "unitsSold" = 0,
      "lastSeenSyncId" = EXCLUDED."lastSeenSyncId",
      "syncedAt" = EXCLUDED."syncedAt"
  `;
}

/**
 * Streams the catalogue JSONL into `VariantSnapshot`.
 *
 * `unitsSold` is reset to 0 on every write because the orders stage runs
 * afterwards and repopulates it; leaving stale figures would mean a variant
 * that stopped selling kept reporting its old volume forever.
 */
export async function ingestCatalog(
  shop: string,
  syncRunId: string,
  url: string,
): Promise<number> {
  let batch: SnapshotRow[] = [];
  let total = 0;

  for await (const line of downloadJsonl<CatalogLine>(url)) {
    const row = toSnapshotRow(line);
    if (!row) continue;

    batch.push(row);
    if (batch.length >= UPSERT_BATCH_SIZE) {
      await upsertSnapshotBatch(shop, syncRunId, batch);
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length) {
    await upsertSnapshotBatch(shop, syncRunId, batch);
    total += batch.length;
  }

  return total;
}

interface OrderLine {
  id?: string;
  createdAt?: string;
  quantity?: number;
  variant?: { id?: string } | null;
  __parentId?: string;
}

export interface SalesTally {
  unitsSold: Map<string, number>;
  ordersScanned: number;
}

/**
 * Tallies units sold per variant from an orders bulk result.
 *
 * Line items arrive as their own JSONL records carrying `__parentId`, so the
 * order they belong to is irrelevant for a units-per-variant count — every line
 * with a quantity and a variant is simply added up. Orders are counted
 * separately by their own records.
 *
 * Exported for testing; the shape of bulk JSONL is exactly the sort of thing
 * that is easy to get subtly wrong.
 */
export function tallySales(lines: Iterable<OrderLine>): SalesTally {
  const unitsSold = new Map<string, number>();
  let ordersScanned = 0;

  for (const line of lines) {
    if (line.variant?.id && typeof line.quantity === "number") {
      const id = toNumericId(line.variant.id);
      unitsSold.set(id, (unitsSold.get(id) ?? 0) + line.quantity);
      continue;
    }
    // A record with no __parentId and an Order gid is a root order record.
    if (!line.__parentId && line.id?.includes("/Order/")) {
      ordersScanned += 1;
    }
  }

  return { unitsSold, ordersScanned };
}

async function writeSalesBatch(
  shop: string,
  entries: Array<[string, number]>,
) {
  if (!entries.length) return;

  const values = entries.map(
    ([variantId, units]) =>
      Prisma.sql`(CAST(${variantId} AS TEXT), CAST(${units} AS INTEGER))`,
  );

  // A single statement rather than one update per variant: a busy store can
  // easily have tens of thousands of distinct variants in a 90-day window.
  await prisma.$executeRaw`
    UPDATE "VariantSnapshot" AS vs
    SET "unitsSold" = v.units
    FROM (VALUES ${Prisma.join(values)}) AS v(variant_id, units)
    WHERE vs."shop" = ${shop} AND vs."variantId" = v.variant_id
  `;
}

export async function ingestOrders(shop: string, url: string): Promise<number> {
  const unitsSold = new Map<string, number>();
  let ordersScanned = 0;

  // Tallying needs the whole file before anything can be written, since one
  // variant appears across many orders. Only a variant id and an integer are
  // held, so this stays small even for a large order history.
  for await (const line of downloadJsonl<OrderLine>(url)) {
    const tally = tallySales([line]);
    ordersScanned += tally.ordersScanned;
    for (const [variantId, units] of tally.unitsSold) {
      unitsSold.set(variantId, (unitsSold.get(variantId) ?? 0) + units);
    }
  }

  const entries = Array.from(unitsSold.entries());
  for (let index = 0; index < entries.length; index += UPSERT_BATCH_SIZE) {
    await writeSalesBatch(shop, entries.slice(index, index + UPSERT_BATCH_SIZE));
  }

  return ordersScanned;
}

/**
 * Every installed shop, with the facts the auto-sync scheduler needs.
 *
 * Installed means "has a session": `app/uninstalled` deletes them, so an
 * uninstalled shop drops out of this list without any extra bookkeeping.
 *
 * Shops that have never opened the app have no `ShopSettings` row yet; they are
 * still returned, with auto-sync on, so a merchant who installs and walks away
 * still gets their first catalogue pulled in.
 */
export async function findAutoSyncCandidates(): Promise<AutoSyncCandidate[]> {
  const sessions = await prisma.session.findMany({
    distinct: ["shop"],
    select: { shop: true },
  });
  if (!sessions.length) return [];

  const shops = sessions.map((session) => session.shop);

  const [settings, activeRuns] = await Promise.all([
    prisma.shopSettings.findMany({
      where: { shop: { in: shops } },
      select: { shop: true, autoSyncEnabled: true, lastSyncedAt: true },
    }),
    prisma.syncRun.findMany({
      where: {
        shop: { in: shops },
        status: { in: ["queued", "running", "ingesting"] },
      },
      select: { shop: true },
      distinct: ["shop"],
    }),
  ]);

  const settingsByShop = new Map(settings.map((row) => [row.shop, row]));
  const busy = new Set(activeRuns.map((row) => row.shop));

  return shops.map((shop) => {
    const row = settingsByShop.get(shop);
    return {
      shop,
      autoSyncEnabled: row?.autoSyncEnabled ?? true,
      lastSyncedAt: row?.lastSyncedAt ?? null,
      hasActiveRun: busy.has(shop),
    };
  });
}

/** Abandons a stuck run and asks Shopify to stop the operation behind it. */
export async function cancelSync(graphql: GraphQLClient, shop: string) {
  const active = await getActiveSyncRun(shop);
  if (!active) return false;

  if (active.bulkOperationId) {
    await cancelBulkOperation(graphql, active.bulkOperationId);
  }

  await prisma.syncRun.update({
    where: { id: active.id },
    data: {
      status: "cancelled",
      finishedAt: new Date(),
      errorMessage: "Cancelled by the merchant.",
    },
  });

  return true;
}
