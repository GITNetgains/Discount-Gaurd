import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { syncAllProducts } from "../models/eligibility.server";
import { getDiscountSettings } from "../models/discount-settings.server";
import prisma from "../db.server";
import { syncDiscountProtection } from "../models/discount-protection.server";

// Full catalog resync of the Discount Guard eligible-products collection.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  try {
    const settings = await getDiscountSettings(session.shop);
    const result = await syncAllProducts(admin, settings.compareAtRule);
    await syncDiscountProtection(admin, session.shop, settings.compareAtRule);
    await prisma.discountSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, compareAtRule: settings.compareAtRule, syncedRule: settings.compareAtRule, lastSyncAt: new Date() },
      update: { syncedRule: settings.compareAtRule, lastSyncAt: new Date(), lastSyncError: null },
    });
    return { result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};
