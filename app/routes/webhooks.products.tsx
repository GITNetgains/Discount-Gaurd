import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { syncProduct } from "../models/eligibility.server";
import { getDiscountSettings } from "../models/discount-settings.server";
import { scheduleDiscountProtection } from "../models/discount-protection.server";

// Keeps the Discount Guard eligible-products collection current when a product's
// price, compare-at price, tags, or MAP metafield change.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const productGid = (payload as { admin_graphql_api_id?: string })
    .admin_graphql_api_id;

  if (admin && productGid) {
    try {
      const settings = await getDiscountSettings(shop);
      await syncProduct(admin, productGid, settings.compareAtRule);
      scheduleDiscountProtection(admin, shop, settings.compareAtRule);
    } catch (error) {
      console.error(`Discount Guard sync failed for ${productGid}`, error);
      // Non-2xx makes Shopify retry the delivery.
      return new Response(null, { status: 500 });
    }
  }

  return new Response();
};
