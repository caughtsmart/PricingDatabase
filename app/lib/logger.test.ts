import { describe, expect, it, vi } from "vitest";

import {
  formatEntry,
  Logger,
  REDACTED,
  redact,
  redactString,
  serialiseError,
  type LogLevel,
} from "./logger";

function capture(level: LogLevel = "debug") {
  const lines: string[] = [];
  const logger = new Logger({
    level,
    pretty: false,
    write: (line) => lines.push(line),
    now: () => new Date("2026-08-06T22:30:00.000Z"),
  });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

describe("redactString", () => {
  it("redacts Shopify offline access tokens", () => {
    expect(redactString("token shpat_abc123DEF456 used")).toBe(
      `token ${REDACTED} used`,
    );
  });

  it("redacts every Shopify token prefix", () => {
    for (const prefix of ["shpat", "shpca", "shppa", "shpss"]) {
      expect(redactString(`${prefix}_secretvalue123`)).toBe(REDACTED);
    }
  });

  it("redacts JWTs, which is what extension session tokens look like", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_123";
    expect(redactString(`Authorization ${jwt}`)).toContain(REDACTED);
    expect(redactString(`Authorization ${jwt}`)).not.toContain("eyJhbGci");
  });

  it("redacts bearer headers", () => {
    expect(redactString("Bearer abc.def.ghi")).toBe(REDACTED);
  });

  it("leaves ordinary text alone", () => {
    expect(redactString("Synced 412 variants for orcs-bazaar")).toBe(
      "Synced 412 variants for orcs-bazaar",
    );
  });
});

describe("redact", () => {
  it("redacts by field name regardless of value", () => {
    const out = redact({
      shop: "orcs-bazaar.myshopify.com",
      accessToken: "totally-innocuous-looking",
      apiSecretKey: "abc",
      authorization: "xyz",
    }) as Record<string, unknown>;

    expect(out.shop).toBe("orcs-bazaar.myshopify.com");
    expect(out.accessToken).toBe(REDACTED);
    expect(out.apiSecretKey).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
  });

  it("redacts a whole session object, the realistic accident", () => {
    // `logger.error("auth failed", { session })` is the line anyone would
    // write, so it has to be safe by default.
    const out = redact({
      session: {
        shop: "orcs-bazaar.myshopify.com",
        accessToken: "shpat_verysecret",
        scope: "read_products",
      },
    }) as Record<string, Record<string, unknown>>;

    expect(out.session.accessToken).toBe(REDACTED);
    expect(out.session.shop).toBe("orcs-bazaar.myshopify.com");
    expect(out.session.scope).toBe("read_products");
  });

  it("redacts secrets nested in arrays", () => {
    const out = redact([{ token: "a" }, { safe: "shpat_leak" }]) as Array<
      Record<string, unknown>
    >;
    expect(out[0].token).toBe(REDACTED);
    expect(out[1].safe).toBe(REDACTED);
  });

  it("survives circular references instead of hanging", () => {
    // A request or session object referencing itself must not turn a log call
    // into an infinite loop.
    const cyclic: Record<string, unknown> = { shop: "a.myshopify.com" };
    cyclic.self = cyclic;

    const out = redact(cyclic) as Record<string, unknown>;
    expect(out.shop).toBe("a.myshopify.com");
    expect(out.self).toBe("[circular]");
  });

  it("passes primitives through untouched", () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it("renders dates as ISO strings", () => {
    expect(redact(new Date("2026-08-06T00:00:00Z"))).toBe(
      "2026-08-06T00:00:00.000Z",
    );
  });
});

describe("serialiseError", () => {
  it("captures name, message and stack", () => {
    const out = serialiseError(new TypeError("bad input"));
    expect(out.name).toBe("TypeError");
    expect(out.message).toBe("bad input");
    expect(out.stack).toContain("TypeError");
  });

  it("walks the cause chain", () => {
    // The useful detail is usually wrapped: "Sync failed" is near-useless
    // without the database error underneath.
    const root = new Error("connection refused");
    const wrapped = new Error("Sync failed", { cause: root });

    const out = serialiseError(wrapped);
    expect(out.message).toBe("Sync failed");
    expect((out.cause as { message: string }).message).toBe(
      "connection refused",
    );
  });

  it("surfaces a Prisma error code and meta", () => {
    const error = Object.assign(new Error("deserialize failed"), {
      code: "P2010",
      meta: { message: "regclass" },
    });

    const out = serialiseError(error);
    expect(out.code).toBe("P2010");
    expect(out.meta).toEqual({ message: "regclass" });
  });

  it("redacts secrets that appear in a message", () => {
    const out = serialiseError(new Error("failed with shpat_leakedtoken"));
    expect(out.message).toBe(`failed with ${REDACTED}`);
  });

  it("handles non-Error throws rather than producing an empty object", () => {
    expect(serialiseError("just a string").message).toBe("just a string");
    expect(serialiseError({ odd: true }).name).toBe("NonError");
  });
});

describe("formatEntry", () => {
  const entry = {
    level: "info" as const,
    time: "2026-08-06T22:30:00.000Z",
    msg: "synced",
    fields: { shop: "a.myshopify.com", count: 3 },
  };

  it("emits one JSON object per line in production mode", () => {
    const parsed = JSON.parse(formatEntry(entry, false));
    expect(parsed).toEqual({
      level: "info",
      time: "2026-08-06T22:30:00.000Z",
      msg: "synced",
      shop: "a.myshopify.com",
      count: 3,
    });
  });

  it("emits a readable line in pretty mode", () => {
    const line = formatEntry(entry, true);
    expect(line).toContain("22:30:00");
    expect(line).toContain("INFO");
    expect(line).toContain("[a.myshopify.com]");
    expect(line).toContain("synced");
  });
});

describe("Logger", () => {
  it("writes structured lines", () => {
    const { logger, parsed } = capture();
    logger.info("catalogue synced", { shop: "a.myshopify.com", variants: 412 });

    expect(parsed()[0]).toMatchObject({
      level: "info",
      msg: "catalogue synced",
      shop: "a.myshopify.com",
      variants: 412,
    });
  });

  it("suppresses lines below the configured level", () => {
    const { logger, lines } = capture("warn");
    logger.debug("noise");
    logger.info("noise");
    logger.warn("kept");
    expect(lines).toHaveLength(1);
  });

  it("stamps child context onto every line", () => {
    const { logger, parsed } = capture();
    logger.child({ shop: "a.myshopify.com" }).info("started");
    expect(parsed()[0].shop).toBe("a.myshopify.com");
  });

  it("lets a call override inherited context", () => {
    const { logger, parsed } = capture();
    logger.child({ stage: "catalog" }).info("done", { stage: "orders" });
    expect(parsed()[0].stage).toBe("orders");
  });

  it("redacts fields on the way out", () => {
    const { logger, parsed } = capture();
    logger.info("auth", { accessToken: "shpat_secret" });
    expect(parsed()[0].accessToken).toBe(REDACTED);
  });

  it("serialises an error passed as a field", () => {
    const { logger, parsed } = capture();
    logger.error("sync failed", { error: new Error("boom") });
    expect(parsed()[0].error).toMatchObject({ name: "Error", message: "boom" });
  });

  it("forwards errors to the reporter with context", () => {
    const captureException = vi.fn();
    const logger = new Logger(
      {
        pretty: false,
        write: () => {},
        reporter: { captureException },
      },
      { shop: "a.myshopify.com" },
    );

    const error = new Error("boom");
    logger.error("sync failed", { error, syncRunId: "run-1" });

    expect(captureException).toHaveBeenCalledOnce();
    const [reported, context] = captureException.mock.calls[0];
    // Reported unwrapped so the reporter can group by stack.
    expect(reported).toBe(error);
    expect(context).toMatchObject({
      shop: "a.myshopify.com",
      syncRunId: "run-1",
      msg: "sync failed",
    });
  });

  it("synthesises an error when none is supplied", () => {
    const captureException = vi.fn();
    const logger = new Logger({ pretty: false, write: () => {}, reporter: { captureException } });
    logger.error("something went wrong");
    expect(captureException.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("does not throw when the reporter fails", () => {
    // A broken monitoring vendor must not escalate into a broken app.
    const logger = new Logger({
      pretty: false,
      write: () => {},
      reporter: {
        captureException: () => {
          throw new Error("sentry down");
        },
      },
    });

    expect(() => logger.error("boom", { error: new Error("x") })).not.toThrow();
  });

  it("does not throw when the write sink fails", () => {
    const logger = new Logger({
      pretty: false,
      write: () => {
        throw new Error("stdout closed");
      },
    });

    expect(() => logger.info("hello")).not.toThrow();
  });
});
