import { describe, expect, it } from "vitest";

import { ordersBulkQuery, parseJsonl } from "./bulk.server";

async function* chunks(...values: string[]) {
  for (const value of values) yield value;
}

async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe("parseJsonl", () => {
  it("parses one record per line", async () => {
    const records = await collect(
      parseJsonl(chunks('{"id":"1"}\n{"id":"2"}\n')),
    );
    expect(records).toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("reassembles a record split across chunk boundaries", async () => {
    // The case that breaks naive implementations: a chunk ends mid-record.
    const records = await collect(
      parseJsonl(chunks('{"id":"1","na', 'me":"Widget"}\n{"id":"2"}\n')),
    );
    expect(records).toEqual([
      { id: "1", name: "Widget" },
      { id: "2" },
    ]);
  });

  it("handles a newline arriving as its own chunk", async () => {
    const records = await collect(
      parseJsonl(chunks('{"id":"1"}', "\n", '{"id":"2"}')),
    );
    expect(records).toHaveLength(2);
  });

  it("yields the final record when the file has no trailing newline", async () => {
    const records = await collect(parseJsonl(chunks('{"id":"1"}\n{"id":"2"}')));
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual({ id: "2" });
  });

  it("skips blank lines rather than throwing on them", async () => {
    const records = await collect(
      parseJsonl(chunks('{"id":"1"}\n\n\n{"id":"2"}\n')),
    );
    expect(records).toHaveLength(2);
  });

  it("returns nothing for an empty body", async () => {
    expect(await collect(parseJsonl(chunks("")))).toEqual([]);
  });

  it("handles many records arriving in one chunk", async () => {
    const body = Array.from({ length: 500 }, (_, i) => `{"id":"${i}"}`).join("\n");
    const records = await collect(parseJsonl<{ id: string }>(chunks(body)));
    expect(records).toHaveLength(500);
    expect(records[499].id).toBe("499");
  });
});

describe("ordersBulkQuery", () => {
  it("filters from the start of the trailing window", () => {
    const query = ordersBulkQuery(90, new Date("2026-08-06T12:00:00Z"));
    expect(query).toContain("created_at:>=2026-05-08");
  });

  it("uses a date, not a timestamp, so the filter is stable within a day", () => {
    const query = ordersBulkQuery(30, new Date("2026-08-06T23:59:00Z"));
    expect(query).toMatch(/created_at:>=\d{4}-\d{2}-\d{2}"/);
  });
});
