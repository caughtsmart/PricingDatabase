import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import type { AppLoadContext, EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";

import { initMonitoring, logger } from "./monitoring.server";
import { startBackgroundJobs } from "./queue.server";
import { addDocumentResponseHeaders } from "./shopify.server";

const ABORT_DELAY = 5000;

// Started first so that anything failing below is reported rather than lost.
void initMonitoring();

// Start the queue when the server boots rather than on the first enqueue: the
// hourly auto-sync schedule has to be running even on a day nobody opens the
// app. A failure here must not stop the server from serving — the app is
// perfectly usable with manual syncs.
if (process.env.RUN_WORKER_IN_PROCESS !== "false") {
  void startBackgroundJobs().catch((error: unknown) => {
    logger.error("Background jobs failed to start", { error });
  });
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _loadContext: AppLoadContext,
) {
  // Sets the Content-Security-Policy frame-ancestors directive that lets the
  // admin embed this app in an iframe. Without it the app renders blank.
  addDocumentResponseHeaders(request, responseHeaders);

  const userAgent = request.headers.get("user-agent");
  const callbackName =
    userAgent && isbot(userAgent) ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          logger.error("Server render failed", {
            error,
            url: request.url,
            // Shopify passes the shop on embedded requests; it is the single
            // most useful field for tracking a report back to a merchant.
            shop: new URL(request.url).searchParams.get("shop") ?? undefined,
          });
          responseStatusCode = 500;
        },
      },
    );

    setTimeout(abort, ABORT_DELAY);
  });
}
