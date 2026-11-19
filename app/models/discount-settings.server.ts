import prisma from "../db.server";
import type { CompareAtRule } from "../lib/discount-eligibility";

export async function getDiscountSettings(shop: string) {
  const saved = await prisma.discountSettings.findUnique({ where: { shop } });
  return {
    compareAtRule: (saved?.compareAtRule === "off" ? "off" : "any") as CompareAtRule,
    syncedRule: saved?.syncedRule ?? null,
    lastSyncAt: saved?.lastSyncAt?.toISOString() ?? null,
    lastSyncError: saved?.lastSyncError ?? null,
  };
}
