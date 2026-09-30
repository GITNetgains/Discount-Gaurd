import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { syncAllProducts } from "../models/eligibility.server";

// Full catalog resync of the Discount Guard eligible-products collection.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  try {
    const result = await syncAllProducts(admin);
    return { result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};
