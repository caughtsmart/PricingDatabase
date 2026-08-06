/**
 * Deciding which shops sync automatically, and when.
 *
 * Kept pure and free of Prisma so the scheduling rules can be tested directly —
 * a bug here is invisible until it either hammers Shopify or quietly stops
 * syncing anyone.
 *
 * The scheduler ticks hourly rather than once a night. Every shop is assigned a
 * fixed hour derived from its own domain, and only shops whose hour matches the
 * current one are enqueued. With a few hundred installs that spreads the work
 * evenly across the day instead of firing every sync at 03:00 and stampeding
 * both Shopify's bulk queue and our own database.
 */

/** Minimum gap between automatic syncs, in hours. */
export const MIN_HOURS_BETWEEN_AUTO_SYNCS = 20;

/**
 * The UTC hour (0–23) at which a given shop syncs.
 *
 * FNV-1a: small, deterministic, and — critically — stable across processes and
 * releases. A shop must land on the same hour tomorrow as it did today, so
 * anything seeded or randomised is unusable here.
 */
export function syncHourForShop(shop: string): number {
  let hash = 0x811c9dc5;
  const normalised = shop.trim().toLowerCase();

  for (let index = 0; index < normalised.length; index += 1) {
    hash ^= normalised.charCodeAt(index);
    // The FNV prime, applied with shifts to stay inside 32 bits.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash % 24;
}

export interface AutoSyncCandidate {
  shop: string;
  /** The merchant's opt-out, from ShopSettings. */
  autoSyncEnabled: boolean;
  lastSyncedAt: Date | null;
  /** True when a sync is already queued, running or ingesting. */
  hasActiveRun: boolean;
}

export type AutoSyncSkipReason =
  | "disabled"
  | "already-running"
  | "not-this-hour"
  | "synced-recently";

export interface AutoSyncDecision {
  shouldSync: boolean;
  reason: AutoSyncSkipReason | "due";
}

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60);
}

/**
 * Whether a shop should be synced on this tick.
 *
 * The `synced-recently` guard is the important one: the hourly tick can fire
 * twice for the same hour after a retry or a restart, and without it a shop
 * would start a second sync while the first was still settling.
 */
export function evaluateAutoSync(
  candidate: AutoSyncCandidate,
  currentHourUtc: number,
  now: Date,
  minHoursBetween: number = MIN_HOURS_BETWEEN_AUTO_SYNCS,
): AutoSyncDecision {
  if (!candidate.autoSyncEnabled) {
    return { shouldSync: false, reason: "disabled" };
  }
  if (candidate.hasActiveRun) {
    return { shouldSync: false, reason: "already-running" };
  }
  if (syncHourForShop(candidate.shop) !== currentHourUtc) {
    return { shouldSync: false, reason: "not-this-hour" };
  }
  if (
    candidate.lastSyncedAt &&
    hoursBetween(candidate.lastSyncedAt, now) < minHoursBetween
  ) {
    return { shouldSync: false, reason: "synced-recently" };
  }

  return { shouldSync: true, reason: "due" };
}

/** Formats a shop's sync hour for display, e.g. "03:00 UTC". */
export function formatSyncHour(shop: string): string {
  return `${String(syncHourForShop(shop)).padStart(2, "0")}:00 UTC`;
}
