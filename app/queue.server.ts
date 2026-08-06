import { PgBoss, fromPrisma } from "pg-boss";

import prisma from "./db.server";
import type { GraphQLClient } from "./lib/catalog.server";
import { processSyncRun } from "./lib/sync.server";
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

export interface SyncJobData {
  shop: string;
  syncRunId: string;
}

declare global {
  // eslint-disable-next-line no-var
  var bossGlobal: Promise<PgBoss> | undefined;
  // eslint-disable-next-line no-var
  var syncWorkerStarted: boolean | undefined;
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
  return boss;
}

/** Lazily starts pg-boss, cached across dev-server reloads. */
export function getBoss(): Promise<PgBoss> {
  if (!global.bossGlobal) {
    global.bossGlobal = createBoss();
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
 * Starts the in-process worker.
 *
 * Running the worker inside the web process keeps deployment to a single
 * service, which is the right default at this size. pg-boss locks jobs in
 * Postgres, so several web instances doing this is safe — a job is still only
 * picked up once. Set `RUN_WORKER_IN_PROCESS=false` and run `npm run worker`
 * separately once ingestion starts competing with request latency.
 */
export async function startSyncWorker(): Promise<void> {
  if (global.syncWorkerStarted) return;
  global.syncWorkerStarted = true;

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

  // eslint-disable-next-line no-console
  console.log("[queue] sync worker started");
}

/** Queues a sync stage for processing. */
export async function enqueueSync(data: SyncJobData): Promise<string | null> {
  const boss = await getBoss();

  if (process.env.RUN_WORKER_IN_PROCESS !== "false") {
    // Started here rather than on module import so that merely importing this
    // file (in a test, or a route that never enqueues) does not open a pool.
    await startSyncWorker();
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
