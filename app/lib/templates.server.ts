import { randomUUID } from "crypto";

import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import type { CostComponentInput } from "./components";
import { rowToInput } from "./costs.server";

/**
 * The named template library: a reusable set of cost blocks — "Imported
 * from EU" — typed once and applied to any product.
 *
 * Applying a template stamps *copies* of its blocks onto the product (the
 * widget does the copying into its draft). Deliberately not linked: editing
 * a template must never silently reprice products that used it. The library
 * is a starting point, not a live dependency.
 *
 * Templates are authored where the merchant already is — the product page —
 * via "save these blocks as a template". Saving under an existing name
 * overwrites that template; the settings page renames and deletes.
 */

export interface CostTemplatePayload {
  id: string;
  name: string;
  blocks: CostComponentInput[];
}

/** Trims a submitted template name to something storable; empty is invalid. */
export function sanitiseTemplateName(raw: unknown): string | null {
  const name = String(raw ?? "").trim().slice(0, 60);
  return name || null;
}

export async function listTemplates(
  shop: string,
): Promise<CostTemplatePayload[]> {
  const templates = await prisma.costTemplate.findMany({
    where: { shop },
    orderBy: { name: "asc" },
  });
  if (templates.length === 0) return [];

  const rows = await prisma.costComponent.findMany({
    where: { shop, templateId: { in: templates.map((template) => template.id) } },
    orderBy: { sortOrder: "asc" },
  });

  const blocksByTemplate = new Map<string, CostComponentInput[]>();
  for (const row of rows) {
    if (!row.templateId) continue;
    const list = blocksByTemplate.get(row.templateId) ?? [];
    // rowToInput reads scope from variantId; template rows have none, so a
    // template block arrives scoped PRODUCT — the right default on apply.
    list.push(rowToInput(row));
    blocksByTemplate.set(row.templateId, list);
  }

  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    blocks: blocksByTemplate.get(template.id) ?? [],
  }));
}

/**
 * Creates or overwrites the template of this name with the given blocks.
 *
 * Same id discipline as saveComponents: client ids are only trusted as
 * parentId references within the list, never as primary keys.
 */
export async function saveTemplate(
  shop: string,
  name: string,
  components: CostComponentInput[],
) {
  const template = await prisma.costTemplate.upsert({
    where: { shop_name: { shop, name } },
    create: { shop, name },
    // The touch keeps updatedAt honest when only the blocks change.
    update: { updatedAt: new Date() },
  });

  const idMap = new Map(
    components.map((component) => [component.id, randomUUID()]),
  );

  await prisma.$transaction([
    prisma.costComponent.deleteMany({
      where: { shop, templateId: template.id },
    }),
    prisma.costComponent.createMany({
      data: components.map((component, index) => ({
        id: idMap.get(component.id)!,
        shop,
        variantId: null,
        productId: null,
        templateId: template.id,
        parentId: component.parentId
          ? (idMap.get(component.parentId) ?? null)
          : null,
        label: component.label,
        kind: component.kind,
        base: component.base ?? "LANDED_COST",
        value: component.value,
        confidence: component.confidence ?? "ESTIMATED",
        enabled: component.enabled !== false,
        sortOrder: index,
      })),
    }),
  ]);

  return template.id;
}

/** Renames a template; false when the new name is already taken. */
export async function renameTemplate(
  shop: string,
  id: string,
  name: string,
): Promise<boolean> {
  try {
    const { count } = await prisma.costTemplate.updateMany({
      where: { id, shop },
      data: { name },
    });
    return count > 0;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
}

export async function deleteTemplate(shop: string, id: string) {
  await prisma.$transaction([
    prisma.costComponent.deleteMany({ where: { shop, templateId: id } }),
    prisma.costTemplate.deleteMany({ where: { id, shop } }),
  ]);
}
