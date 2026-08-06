import type { GraphQLClient } from "./catalog.server";

/**
 * Shopify Bulk Operations: submitting queries and reading the JSONL results.
 *
 * Bulk operations replace cursor pagination for whole-catalogue reads. Shopify
 * runs the query on its own infrastructure and hands back a JSONL file, which
 * removes both the rate-limit paging cost and the hard page cap the old
 * synchronous sync had to impose.
 *
 * Two things about the JSONL format matter here:
 *
 *  - Nested **connections** are flattened into their own lines, each carrying a
 *    `__parentId` pointing at the record above it. That is why order line items
 *    arrive as separate lines from their orders.
 *  - Nested **single objects** stay inline. A variant's `product` is one object,
 *    so it stays on the variant's line and each line is self-contained.
 *
 * Result URLs expire after seven days, which is irrelevant for a sync consumed
 * within seconds but worth knowing if you ever cache one.
 */

export const START_BULK_QUERY_MUTATION = `#graphql
  mutation StartBulkQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status createdAt }
      userErrors { field message }
    }
  }
`;

export const BULK_OPERATION_STATUS_QUERY = `#graphql
  query BulkOperationStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        rootObjectCount
        fileSize
        url
        partialDataUrl
        completedAt
      }
    }
  }
`;

export const CANCEL_BULK_OPERATION_MUTATION = `#graphql
  mutation CancelBulkOperation($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

/** The catalogue extract. Runs as the inner query of a bulk operation. */
export const CATALOG_BULK_QUERY = `
  {
    productVariants {
      edges {
        node {
          id
          title
          sku
          price
          compareAtPrice
          inventoryQuantity
          inventoryItem { unitCost { amount } }
          product {
            id
            title
            vendor
            productType
            status
            featuredMedia { preview { image { url } } }
          }
        }
      }
    }
  }
`;

/** The sales extract for realised margin, over a trailing window. */
export function ordersBulkQuery(windowDays: number, now = new Date()): string {
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const day = since.toISOString().slice(0, 10);
  return `
    {
      orders(query: "created_at:>=${day}", sortKey: CREATED_AT) {
        edges {
          node {
            id
            createdAt
            lineItems {
              edges {
                node {
                  quantity
                  variant { id }
                }
              }
            }
          }
        }
      }
    }
  `;
}

export interface BulkOperationState {
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: number;
  url: string | null;
  partialDataUrl: string | null;
}

export class BulkOperationError extends Error {}

/**
 * Submits a bulk query and returns the new operation's id.
 *
 * Shopify permits only one bulk *query* per shop at a time; if one is already
 * running this surfaces as a user error rather than an exception, so it is
 * turned into one here for the caller to handle.
 */
export async function startBulkQuery(
  graphql: GraphQLClient,
  query: string,
): Promise<string> {
  const response = await graphql(START_BULK_QUERY_MUTATION, {
    variables: { query },
  });
  const body = (await response.json()) as {
    data?: {
      bulkOperationRunQuery?: {
        bulkOperation: { id: string; status: string } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      } | null;
    };
  };

  const result = body.data?.bulkOperationRunQuery;
  if (result?.userErrors?.length) {
    throw new BulkOperationError(
      result.userErrors.map((error) => error.message).join(" "),
    );
  }
  if (!result?.bulkOperation?.id) {
    throw new BulkOperationError("Shopify did not return a bulk operation.");
  }

  return result.bulkOperation.id;
}

export async function getBulkOperation(
  graphql: GraphQLClient,
  id: string,
): Promise<BulkOperationState | null> {
  const response = await graphql(BULK_OPERATION_STATUS_QUERY, {
    variables: { id },
  });
  const body = (await response.json()) as {
    data?: {
      node?: {
        id: string;
        status: string;
        errorCode: string | null;
        objectCount: string | number | null;
        url: string | null;
        partialDataUrl: string | null;
      } | null;
    };
  };

  const node = body.data?.node;
  if (!node?.id) return null;

  return {
    id: node.id,
    status: node.status,
    errorCode: node.errorCode ?? null,
    objectCount: Number(node.objectCount ?? 0) || 0,
    url: node.url ?? null,
    partialDataUrl: node.partialDataUrl ?? null,
  };
}

export async function cancelBulkOperation(graphql: GraphQLClient, id: string) {
  try {
    await graphql(CANCEL_BULK_OPERATION_MUTATION, { variables: { id } });
  } catch {
    // Cancelling is best-effort housekeeping — never let it fail a sync.
  }
}

/* -------------------------------------------------------------------------- */
/* JSONL                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Splits a chunked byte stream into JSONL records.
 *
 * Written as a generator over an async iterable of strings so the parsing logic
 * can be unit tested against arbitrary chunk boundaries — including a chunk that
 * splits a line in half, which is the case that breaks naive implementations.
 * A result file can be hundreds of megabytes, so nothing here buffers the whole
 * body.
 */
export async function* parseJsonl<T = Record<string, unknown>>(
  chunks: AsyncIterable<string>,
): AsyncGenerator<T> {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) yield JSON.parse(line) as T;
      newlineIndex = buffer.indexOf("\n");
    }
  }

  // A file that does not end in a newline still has a final record.
  const last = buffer.trim();
  if (last) yield JSON.parse(last) as T;
}

/** Decodes a fetch body into text chunks for {@link parseJsonl}. */
export async function* streamText(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream: true keeps multi-byte characters intact across chunk edges.
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** Downloads a bulk result URL and yields its records one at a time. */
export async function* downloadJsonl<T = Record<string, unknown>>(
  url: string,
): AsyncGenerator<T> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new BulkOperationError(
      `Could not download bulk result (${response.status}).`,
    );
  }
  yield* parseJsonl<T>(streamText(response.body));
}
