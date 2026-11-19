import type { LoaderFunctionArgs } from "react-router";
import { storefrontSaleGroups } from "../models/storefront-sale-groups.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const collectionId = url.searchParams.get("collection") ?? "";
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !/^\d+$/.test(collectionId)) {
    return Response.json({ groups: [], soldOut: [] }, { status: 400, headers });
  }
  try {
    return Response.json(await storefrontSaleGroups(shop, collectionId), { headers });
  } catch (error) {
    console.error("[storefront-sale-groups]", error instanceof Error ? error.message : "Request failed");
    return Response.json({ groups: [], soldOut: [] }, { status: 503, headers });
  }
}
