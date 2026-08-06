import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  // eslint-disable-next-line no-console
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = payload.current as string[];
  if (session) {
    await prisma.session.update({
      where: { id: session.id },
      data: { scope: current.toString() },
    });
  }

  return new Response();
}
