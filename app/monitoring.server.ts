import {
  Logger,
  redact,
  serialiseError,
  type ErrorReporter,
  type LogFields,
  type LogLevel,
} from "./lib/logger";

/**
 * Process-wide error monitoring.
 *
 * Wires three things together:
 *
 *  1. A structured logger, used everywhere in place of `console.*`.
 *  2. An optional Sentry reporter, active only when `SENTRY_DSN` is set — so
 *     the app runs identically with no monitoring vendor configured.
 *  3. Handlers for `unhandledRejection` and `uncaughtException`, which is where
 *     background failures would otherwise vanish. The sync worker runs detached
 *     from any request; without these, a rejected promise inside a job is a
 *     silent no-op.
 *
 * The reporter is deliberately behind the `ErrorReporter` interface rather than
 * called directly. Swapping Sentry for anything else is then a single adapter,
 * and — more usefully — the redaction rules stay in one place instead of being
 * something each vendor's SDK has to be trusted to respect.
 */

declare global {
  // eslint-disable-next-line no-var
  var loggerGlobal: Logger | undefined;
  // eslint-disable-next-line no-var
  var monitoringStarted: boolean | undefined;
}

function resolveLevel(): LogLevel {
  const configured = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (
    configured === "debug" ||
    configured === "info" ||
    configured === "warn" ||
    configured === "error"
  ) {
    return configured;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

/**
 * The application logger.
 *
 * Cached on globalThis so the dev server's module reloading does not produce a
 * fresh logger — and a fresh set of process handlers — on every edit.
 */
export const logger: Logger =
  global.loggerGlobal ??
  new Logger({
    level: resolveLevel(),
    pretty: process.env.NODE_ENV !== "production",
  });

if (process.env.NODE_ENV !== "production") {
  global.loggerGlobal = logger;
}

/** Convenience for the common case of tagging every line with a shop. */
export function shopLogger(shop: string): Logger {
  return logger.child({ shop });
}

/* -------------------------------------------------------------------------- */
/* Sentry                                                                     */
/* -------------------------------------------------------------------------- */

type SentryModule = typeof import("@sentry/node");

/**
 * Adapts Sentry to the reporter interface.
 *
 * `beforeSend` re-runs the app's own redaction over the outgoing event. Sentry
 * attaches request and context data by itself, so relying solely on redacting
 * at the call site would leave a path for an access token to reach a third
 * party. Belt and braces is the right posture for a credential that grants
 * access to a merchant's entire store.
 */
async function createSentryReporter(
  dsn: string,
): Promise<ErrorReporter | null> {
  try {
    const Sentry: SentryModule = await import("@sentry/node");

    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? "development",
      release: process.env.SENTRY_RELEASE,
      // Never let the SDK collect user identifiers on its own initiative.
      sendDefaultPii: false,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
      beforeSend(event) {
        return redact(event) as typeof event;
      },
    });

    return {
      captureException(error: unknown, context: LogFields) {
        Sentry.captureException(error, {
          extra: redact(context) as Record<string, unknown>,
          tags: context.shop ? { shop: String(context.shop) } : undefined,
        });
      },
    };
  } catch (error) {
    // A monitoring vendor failing to load is not a reason to fail the app; log
    // it and carry on with structured logs only.
    logger.warn("Sentry could not be initialised; continuing without it", {
      error: serialiseError(error),
    });
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Process handlers                                                           */
/* -------------------------------------------------------------------------- */

function installProcessHandlers() {
  process.on("unhandledRejection", (reason) => {
    // The most likely source is a background job: a rejected promise inside a
    // queue handler that nothing awaited.
    logger.error("Unhandled promise rejection", { error: reason });
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", { error });

    // Node's default is to terminate, and that default exists for a reason: the
    // process is now in an undefined state. Installing a handler suppresses it,
    // so exit deliberately and let the platform restart a clean process.
    // Opt out with UNCAUGHT_EXCEPTION_EXIT=false if your host cannot restart.
    if (process.env.UNCAUGHT_EXCEPTION_EXIT !== "false") {
      // Give the log line a tick to flush before the process goes away.
      setTimeout(() => process.exit(1), 100).unref();
    }
  });
}

/**
 * Starts monitoring. Safe to call more than once.
 *
 * Called from `entry.server.tsx` and the standalone worker, so both the web
 * process and any detached worker report errors the same way.
 *
 * Note on Sentry: its Node SDK prefers being initialised before the modules it
 * instruments, via `--import ./instrument.mjs`. Loading it here means automatic
 * HTTP/database instrumentation may be incomplete — but explicit
 * `captureException` reporting, which is what this app relies on, works fine.
 * Add the `--import` hook if you later want tracing as well.
 */
export async function initMonitoring(): Promise<void> {
  if (global.monitoringStarted) return;
  global.monitoringStarted = true;

  installProcessHandlers();

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info("Error monitoring: structured logs only (no SENTRY_DSN set)");
    return;
  }

  const reporter = await createSentryReporter(dsn);
  if (reporter) {
    logger.setReporter(reporter);
    logger.info("Error monitoring: reporting to Sentry");
  }
}
