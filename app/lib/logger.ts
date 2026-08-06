/**
 * Structured logging with secret redaction.
 *
 * Two things drove the shape of this module.
 *
 * First, **most of this app's failures happen where nobody is watching.** The
 * catalogue sync runs from a webhook and a job queue, so a merchant's 03:00
 * sync can fail with no one on the other end of the request. Errors have to be
 * findable after the fact, which means machine-readable lines carrying the shop
 * they belong to — not prose printed to stdout.
 *
 * Second, **this process handles Shopify access tokens.** An offline token is a
 * long-lived credential for a merchant's entire store. Logging one into a
 * third-party aggregator would be a security incident, and it is an easy
 * accident: `logger.error("auth failed", { session })` is the sort of line
 * anyone would write. Redaction is therefore applied to everything, always,
 * rather than being left to the caller to remember.
 *
 * Kept free of Prisma, Sentry and the network so the redaction and
 * serialisation rules can be tested directly.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogFields {
  /** The shop a line belongs to. Present on nearly every line worth reading. */
  shop?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  time: string;
  msg: string;
  fields: LogFields;
}

/**
 * Field names whose values are replaced wholesale.
 *
 * Matched loosely (substring, case-insensitive) because the risk is asymmetric:
 * redacting a harmless field costs a debugging session, leaking a token costs a
 * merchant their store.
 */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|auth|apikey|api_key|credential|cookie|signature|hmac)/i;

/**
 * Value shapes that are secrets wherever they appear.
 *
 * Shopify's token prefixes (`shpat_` offline, `shpca_` custom app, `shppa_`
 * private app, `shpss_` shared secret) plus anything shaped like a JWT, which
 * is what session tokens from admin extensions look like.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bshp(at|ca|pa|ss)_[A-Za-z0-9]+/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
];

export const REDACTED = "[redacted]";

/** Replaces secret-shaped substrings inside a string. */
export function redactString(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED),
    value,
  );
}

/**
 * Recursively redacts a value for logging.
 *
 * Handles cycles, because log fields regularly contain request or session
 * objects that reference themselves and a naive walk would hang the process —
 * turning a logging call into an outage.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serialiseError(value, seen);

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(item, seen);
  }
  return out;
}

export interface SerialisedError {
  name: string;
  message: string;
  stack?: string;
  /** Prisma error code, HTTP status, or similar, when the error carries one. */
  code?: string | number;
  cause?: unknown;
  [key: string]: unknown;
}

/**
 * Turns an error into something worth reading in a log aggregator.
 *
 * Walks the `cause` chain, because the most useful detail is usually wrapped:
 * "Sync failed" is nearly useless without the Postgres error underneath it.
 * Non-Error throws are handled too — a rejected fetch or a thrown string should
 * not produce `{}`.
 */
export function serialiseError(
  error: unknown,
  seen = new WeakSet<object>(),
): SerialisedError {
  if (!(error instanceof Error)) {
    return {
      name: "NonError",
      message: typeof error === "string" ? redactString(error) : String(error),
      value: redact(error, seen),
    };
  }

  const out: SerialisedError = {
    name: error.name,
    message: redactString(error.message),
  };

  if (error.stack) out.stack = redactString(error.stack);

  // Prisma puts the useful identifier on `code`; fetch-style errors use
  // `status`. Both are worth surfacing without dumping the whole object.
  const extra = error as unknown as Record<string, unknown>;
  if (typeof extra.code === "string" || typeof extra.code === "number") {
    out.code = extra.code;
  }
  if (typeof extra.status === "number") out.status = extra.status;
  if (extra.meta !== undefined) out.meta = redact(extra.meta, seen);

  if (error.cause !== undefined && error.cause !== null) {
    out.cause = serialiseError(error.cause, seen);
  }

  return out;
}

/** Renders an entry as a single line. */
export function formatEntry(entry: LogEntry, pretty: boolean): string {
  if (!pretty) {
    return JSON.stringify({
      level: entry.level,
      time: entry.time,
      msg: entry.msg,
      ...entry.fields,
    });
  }

  const shop = entry.fields.shop ? ` [${entry.fields.shop}]` : "";
  const rest = { ...entry.fields };
  delete rest.shop;
  const suffix = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  const time = entry.time.slice(11, 19);

  return `${time} ${entry.level.toUpperCase().padEnd(5)}${shop} ${entry.msg}${suffix}`;
}

/** Where errors are reported in addition to the log stream. */
export interface ErrorReporter {
  captureException(error: unknown, context: LogFields): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Human-readable output. Defaults on outside production. */
  pretty?: boolean;
  /** Injected for testing; defaults to stdout/stderr. */
  write?: (line: string, level: LogLevel) => void;
  reporter?: ErrorReporter | null;
  /** Timestamp source, injected so tests are deterministic. */
  now?: () => Date;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly pretty: boolean;
  private readonly write: (line: string, level: LogLevel) => void;
  private readonly now: () => Date;
  private reporter: ErrorReporter | null;
  private readonly context: LogFields;

  constructor(options: LoggerOptions = {}, context: LogFields = {}) {
    this.level = options.level ?? "info";
    this.pretty = options.pretty ?? process.env.NODE_ENV !== "production";
    this.write =
      options.write ??
      ((line, level) => {
        // eslint-disable-next-line no-console
        if (level === "error" || level === "warn") console.error(line);
        // eslint-disable-next-line no-console
        else console.log(line);
      });
    this.reporter = options.reporter ?? null;
    this.now = options.now ?? (() => new Date());
    this.context = context;
  }

  /** A logger that stamps every line with extra fields, e.g. the shop. */
  child(context: LogFields): Logger {
    return new Logger(
      {
        level: this.level,
        pretty: this.pretty,
        write: this.write,
        reporter: this.reporter,
        now: this.now,
      },
      { ...this.context, ...context },
    );
  }

  /** Attaches the error reporter after construction, once its DSN is known. */
  setReporter(reporter: ErrorReporter | null) {
    this.reporter = reporter;
  }

  private emit(level: LogLevel, msg: string, fields: LogFields = {}) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const merged = { ...this.context, ...fields };
    const entry: LogEntry = {
      level,
      time: this.now().toISOString(),
      msg,
      fields: redact(merged) as LogFields,
    };

    try {
      this.write(formatEntry(entry, this.pretty), level);
    } catch {
      // Logging must never be the reason a request fails.
    }
  }

  debug = (msg: string, fields?: LogFields) => this.emit("debug", msg, fields);
  info = (msg: string, fields?: LogFields) => this.emit("info", msg, fields);
  warn = (msg: string, fields?: LogFields) => this.emit("warn", msg, fields);

  /**
   * Logs an error and forwards it to the reporter.
   *
   * Pass the original error as `fields.error`; it is serialised for the log
   * line and handed to the reporter unwrapped so stack grouping still works.
   */
  error(msg: string, fields: LogFields & { error?: unknown } = {}) {
    const { error, ...rest } = fields;
    this.emit("error", msg, {
      ...rest,
      ...(error === undefined ? {} : { error: serialiseError(error) }),
    });

    if (this.reporter) {
      try {
        this.reporter.captureException(error ?? new Error(msg), {
          ...this.context,
          ...rest,
          msg,
        });
      } catch {
        // A failing reporter must not escalate into a failing request.
      }
    }
  }
}
