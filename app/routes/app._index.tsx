import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { findEligibleCollection } from "../models/eligibility.server";
import type { action as resyncAction } from "./app.resync";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const collection = await findEligibleCollection(admin);
  return { eligibleCollectionId: collection?.collectionId ?? null };
};

export default function Index() {
  const { eligibleCollectionId } = useLoaderData<typeof loader>();
  const resync = useFetcher<typeof resyncAction>();

  const shopify = useAppBridge();
  const isResyncing = resync.state !== "idle";

  useEffect(() => {
    if (!resync.data) return;
    if ("error" in resync.data && resync.data.error) {
      shopify.toast.show(resync.data.error, { isError: true });
    } else if ("result" in resync.data && resync.data.result) {
      const { eligible, excluded } = resync.data.result;
      shopify.toast.show(`Resynced: ${eligible} eligible, ${excluded} excluded`);
    }
  }, [resync.data, shopify]);

  return (
    <s-page heading="Discount Guard">
      <s-section heading="Discount Guard">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Create a promotional code that automatically excludes sale-priced
            and MAP Restricted items. Works on every Shopify plan: codes are
            native Shopify discounts limited to an app-managed, hidden
            &quot;Discount Guard – Eligible&quot; collection that updates
            automatically when products change. Do not edit or delete that
            collection.
          </s-paragraph>
          {resync.data && "result" in resync.data && resync.data.result && (
            <s-banner tone="success" heading="Eligible products resynced">
              {resync.data.result.eligible} eligible,{" "}
              {resync.data.result.excluded} excluded (
              {resync.data.result.added} added, {resync.data.result.removed}{" "}
              removed).
            </s-banner>
          )}
          <s-stack direction="inline" gap="base">
            <s-button href="/app/discounts/new" variant="primary">
              Create Discount Guard code
            </s-button>
            {eligibleCollectionId && (
              <s-button
                onClick={() =>
                  resync.submit({}, { method: "POST", action: "/app/resync" })
                }
                {...(isResyncing ? { loading: true } : {})}
              >
                Resync eligible products
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Sale Calendar">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Upload the holiday sale sheet and pick a collection. Each sale&apos;s
            products are shown in that collection from its start date and
            removed after its end date.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button href="/app/sale-calendar">Open Sale Calendar</s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Bulk tag products">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Add or remove a tag (for example &quot;MAP Restricted&quot;) by vendor
            or on-sale status.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button href="/app/bulk-tag">Open Bulk tag</s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
