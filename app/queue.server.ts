import { PgBoss, fromPrisma } from "pg-boss";

import prisma from "./db.server";
import { evaluateAutoSync } from "./lib/autosync";
import type { GraphQLClient } from "./lib/catalog.server";
import {
  findAutoSyncCandidates,
  processSyncRun,
  startSync,
} from "./lib/sync.server";
import { unauthenticated } from "./shopify.server";

/**
 * Background job queue, backed by the Postgres the app already uses.
 *
 * pg-boss was chosen over Redis-based queues purely to avoid adding a second
 * piece of infrastructure to run and pay for. It gives durability across
 * restarts, retries with backoff, and safe locking across instances, which a
 * detached promise in a webhook handler would not: a deploy mid-ingest would
 * silently lose the work.
 *
 * pg-boss manages its own `pgboss` schema and migrations, so it needs no Prisma
 * model of its own.
 */

export const SYNC_QUEUE = "margin-lens.sync";
export const NIGHTLY_QUEUE = "margin-lens.nightly";

/**
 * The scheduler ticks hourly, not nightly.
 *
 * Each shop is assigned a fixed hour derived from its domain, and a tick only
 * enqueues shops whose hour it currently is. That spreads load across the day
 * instead of firing every install's sync at the same moment.
 */
const NIGHTLY_CRON = "0 * * * *";
const NIGHTLY_SCHEDULE_KEY = "hourly-tick";

export interface SyncJobData {
  shop: string;
  syncRunId: string;
}

declare global {
  // eslint-disable-next-line no-var
  var bossGlobal: Promise<PgBoss> | undefined;
  // eslint-disable-next-line no-var
  var backgroundJobsGlobal: Promise<void> | undefined;
}

async function createBoss(): Promise<PgBoss> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run background jobs.");
  }

  const boss = new PgBoss({
    connectionString,
    // Run the queue's SQL through Prisma's existing pool rather than opening a
    // second one. A Shopify app is usually deployed somewhere with a tight
    // Postgres connection limit, and two pools per instance is how you find it.
    db: fromPrisma(prisma),
    schema: "pgboss",
  });

  boss.on("error", (error: Error) => {
    // eslint-disable-next-line no-console
    console.error("[queue] pg-boss error", error);
  });

  await boss.start();
  await boss.createQueue(SYNC_QUEUE);
  await boss.createQueue(NIGHTLY_QUEUE);
  return boss;
}

/**
 * Lazily starts pg-boss, cached across dev-server reloads.
 *
 * The cached promise is cleared if it rejects. Caching a rejection would mean a
 * database blip at boot left this process unable to run a background job ever
 * again, which is exactly the failure a retry is meant to cover.
 */
export function getBoss(): Promise<PgBoss> {
  if (!global.bossGlobal) {
    global.bossGlobal = createBoss().catch((error: unknown) => {
      global.bossGlobal = undefined;
      throw error;
    });
  }
  return global.bossGlobal;
}

/**
 * Runs one sync stage.
 *
 * Resolves an offline session for the shop rather than using a request's
 * session, because this executes outside any request — potentially minutes
 * after the merchant navigated away.
 */
async function handleSyncJob(data: SyncJobData) {
  const { admin } = await unauthenticated.admin(data.shop);
  await processSyncRun(
    admin.graphql as GraphQLClient,
    data.shop,
    data.syncRunId,
  );
}

/**
 * One tick of the auto-sync scheduler.
 *
 * Enumerates installed shops and starts a sync for those whose assigned hour
 * has come round. A shop that fails is logged and skipped rather than aborting
 * the tick — one shop with a revoked token must not stop every other shop from
 * syncing that hour.
 */
export async function runNightlyTick(now = new Date()): Promise<{
  considered: number;
  started: number;
  failed: number;
}> {
  const candidates = await findAutoSyncCandidates();
  const currentHourUtc = now.getUTCHours();

  let started = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const decision = evaluateAutoSync(candidate, currentHourUtc, now);
    if (!decision.shouldSync) continue;

    try {
      const { admin } = await unauthenticated.admin(candidate.shop);
      const result = await startSync(
        admin.graphql as GraphQLClient,
        candidate.shop,
      );
      if (result.started) started += 1;
      // eslint-disable-next-line no-console
      console.log(`[queue] auto-sync ${candidate.shop}: ${result.message}`);
    } catch (error) {
      failed += 1;
      // Most often an uninstalled shop whose session has not been cleaned up,
      // or a revoked access token.
      // eslint-disable-next-line no-console
      console.error(`[queue] auto-sync failed for ${candidate.shop}`, error);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[queue] nightly tick hour=${currentHourUtc} considered=${candidates.length} started=${started} failed=${failed}`,
  );

  return { considered: candidates.length, started, failed };
}

/**
 * Starts the in-process workers and registers the hourly schedule.
 *
 * Running these inside the web process keeps deployment to a single service,
 * which is the right default at this size. pg-boss locks jobs in Postgres, so
 * several web instances doing this is safe — a job is still only picked up
 * once, and the schedule is keyed so repeated registration just updates it.
 *
 * Set `RUN_WORKER_IN_PROCESS=false` and run `npm run worker` separately once
 * ingestion starts competing with request latency.
 */
export function startBackgroundJobs(): Promise<void> {
  if (!global.backgroundJobsGlobal) {
    global.backgroundJobsGlobal = doStartBackgroundJobs().catch(
      (error: unknown) => {
        // Same reasoning as getBoss: a failed start must not be remembered as
        // "already started", or the schedule silently never runs again.
        global.backgroundJobsGlobal = undefined;
        throw error;
      },
    );
  }
  return global.backgroundJobsGlobal;
}

async function doStartBackgroundJobs(): Promise<void> {
  const boss = await getBoss();

  await boss.work<SyncJobData>(
    SYNC_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs: Array<{ data: SyncJobData }>) => {
      for (const job of jobs) {
        // eslint-disable-next-line no-console
        console.log(
          `[queue] sync ${job.data.syncRunId} for ${job.data.shop}`,
        );
        await handleSyncJob(job.data);
      }
    },
  );

  await boss.work(
    NIGHTLY_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 30 },
    async () => {
      await runNightlyTick();
    },
  );

  // Idempotent: re-registering the same (queue, key) updates the existing
  // schedule rather than stacking another one.
  await boss.schedule(NIGHTLY_QUEUE, NIGHTLY_CRON, null, {
    key: NIGHTLY_SCHEDULE_KEY,
    tz: "UTC",
    // A tick is worthless once the next one is due; never let a backlog build.
    retryLimit: 0,
    expireInSeconds: 3000,
    singletonKey: NIGHTLY_SCHEDULE_KEY,
  });

  // eslint-disable-next-line no-console
  console.log("[queue] background jobs started (sync worker + hourly schedule)");
}

/** Backwards-compatible alias. */
export const startSyncWorker = startBackgroundJobs;

/** Queues a sync stage for processing. */
export async function enqueueSync(data: SyncJobData): Promise<string | null> {
  const boss = await getBoss();

  if (process.env.RUN_WORKER_IN_PROCESS !== "false") {
    // Safety net for the case where the boot hook did not run; the flag inside
    // makes a second call a no-op.
    await startBackgroundJobs();
  }

  return boss.send(SYNC_QUEUE, data, {
    // A very large catalogue can take a few minutes to stream in.
    expireInSeconds: Number(process.env.SYNC_JOB_TIMEOUT_SECONDS || 900),
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // One job per run stage. Shopify can deliver a webhook more than once, and
    // a duplicate ingest would be wasted work at best.
    singletonKey: `${data.shop}:${data.syncRunId}`,
  });
}
