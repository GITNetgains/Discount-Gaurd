import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncShop } from "./sale-calendar.server";

// Runs the Sale Calendar sync for every shop with a chosen collection, every
// few minutes, so sales start and end on time without anyone opening the app.

const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_MS = 30 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var saleSchedulerStarted: boolean | undefined;
}

async function runAll() {
  const shops = await prisma.saleSettings.findMany({
    where: { collectionId: { not: null } },
    select: { shop: true },
  });
  for (const { shop } of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      await syncShop(admin, shop);
    } catch (error) {
      console.error(`[sale-calendar] sync failed for ${shop}:`, error);
    }
  }
}

export function startSaleScheduler() {
  if (global.saleSchedulerStarted) return;
  global.saleSchedulerStarted = true;
  const tick = () => runAll().catch((e) => console.error("[sale-calendar]", e));
  setTimeout(tick, FIRST_RUN_MS);
  setInterval(tick, INTERVAL_MS);
}
