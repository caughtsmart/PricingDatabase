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
import { startBackgroundJobs, getBoss } from "./app/queue.server";

async function main() {
  await startBackgroundJobs();
  // eslint-disable-next-line no-console
  console.log("[worker] ready");
}

async function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`[worker] ${signal} received, finishing in-flight jobs`);
  try {
    const boss = await getBoss();
    // Let a running ingest finish rather than tearing it up mid-stream; an
    // interrupted catalogue import would leave rows with a stale sync stamp.
    await boss.stop({ graceful: true });
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[worker] failed to start", error);
  process.exit(1);
});
