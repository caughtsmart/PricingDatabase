/**
 * Standalone worker entry point.
 *
 * Only needed once background ingestion starts competing with request latency —
 * until then the web process runs the worker itself. To split them:
 *
 *   web:    RUN_WORKER_IN_PROCESS=false npm start
 *   worker: npm run worker
 *
 * pg-boss locks jobs in Postgres, so running several of these is safe.
 */
import { initMonitoring, logger } from "./app/monitoring.server";
import { startBackgroundJobs, getBoss } from "./app/queue.server";

async function main() {
  // The worker has no request cycle and no user watching it, so monitoring
  // matters more here than in the web process, not less.
  await initMonitoring();
  await startBackgroundJobs();
  logger.info("Worker ready");
}

async function shutdown(signal: string) {
  logger.info("Shutting down, finishing in-flight jobs", { signal });
  try {
    const boss = await getBoss();
    // Let a running ingest finish rather than tearing it up mid-stream; an
    // interrupted catalogue import would leave rows with a stale sync stamp.
    await boss.stop({ graceful: true });
  } catch (error) {
    logger.error("Graceful shutdown failed", { error });
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((error: unknown) => {
  logger.error("Worker failed to start", { error });
  process.exit(1);
});
