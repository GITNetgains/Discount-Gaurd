import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getDiscountSettings } from "../models/discount-settings.server";
import { getDiscountCoverage } from "../models/discount-coverage.server";
import { findEligibleCollection, syncAllProducts } from "../models/eligibility.server";
import type { CompareAtRule } from "../lib/discount-eligibility";
import { syncDiscountProtection } from "../models/discount-protection.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getDiscountSettings(session.shop);
  let coverage: Awaited<ReturnType<typeof getDiscountCoverage>> = [];
  let coverageError: string | null = null;
  try {
    const collection = await findEligibleCollection(admin);
    const mirrors = await prisma.discountCollectionMirror.findMany({ where: { shop: session.shop } });
    coverage = await getDiscountCoverage(admin, collection?.collectionId ?? null, settings.compareAtRule === "any" ? mirrors.map(m => m.protectedCollectionId) : []);
  } catch (error) {
    coverageError = error instanceof Error ? error.message : "Unable to check discount coverage.";
  }
  return { settings, coverage, coverageError };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const rule = form.get("compareAtRule");
  if (rule !== "any" && rule !== "off") return { error: "Choose ON or OFF for compare-at protection." };
  try {
    await prisma.discountSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, compareAtRule: rule },
      update: { compareAtRule: rule, lastSyncError: null },
    });
    const result = await syncAllProducts(admin, rule);
    const protection = await syncDiscountProtection(admin, session.shop, rule);
    await prisma.discountSettings.update({
      where: { shop: session.shop },
      data: { syncedRule: rule, lastSyncAt: new Date(), lastSyncError: null },
    });
    return { result, rule, protection };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to sync eligible products.";
    await prisma.discountSettings.updateMany({
      where: { shop: session.shop }, data: { lastSyncError: message },
    });
    return { error: `Protection has not finished syncing. Retry Save & resync. ${message}` };
  }
};

export default function Settings() {
  const { settings, coverage, coverageError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [rule, setRule] = useState<CompareAtRule>(settings.compareAtRule);
  const saving = fetcher.state !== "idle";
  useEffect(() => { setRule(settings.compareAtRule); }, [settings.compareAtRule]);
  const needsReview = coverage.filter(row => !row.covered && !row.shippingOnly);
  const pending = settings.syncedRule !== settings.compareAtRule || !!settings.lastSyncError;
  return (
    <s-page heading="Settings">
      <s-section heading="Compare-at price protection">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Exclude products with a compare-at price from supported native collection-based product discounts.
            Regular-price products remain eligible, including in mixed carts.
          </s-paragraph>
          <s-switch
            label="Block discounts on compare-at priced products"
            checked={rule === "any"}
            disabled={saving}
            onChange={(event: Event) => setRule((event.target as HTMLInputElement).checked ? "any" : "off")}
          />
          <s-paragraph>
            {rule === "any"
              ? "ON: any compare-at price on any variant excludes the whole product, even if it equals or is below the current price."
              : "OFF: existing native discounts return to their original collections; compare-at price does not exclude products."}
            {" "}MAP Restricted products remain excluded separately.
          </s-paragraph>
          {pending && (
            <s-banner tone="warning" heading="Product eligibility needs syncing">
              Save &amp; resync to apply the selected rule to existing products.
              {settings.lastSyncError ? ` Last error: ${settings.lastSyncError}` : ""}
            </s-banner>
          )}
          {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
            <s-banner tone="critical" heading="Sync incomplete">{fetcher.data.error}</s-banner>
          )}
          {fetcher.data && "result" in fetcher.data && fetcher.data.result && (
            <s-banner tone="success" heading="Settings saved and eligible products synced">
              {fetcher.data.result.eligible} eligible, {fetcher.data.result.excluded} excluded.
              {" "}{fetcher.data.protection.managed} native discounts checked; {fetcher.data.protection.updated} scopes updated.
              Coverage below shows which discounts use this rule.
            </s-banner>
          )}
          <s-button variant="primary" {...(saving ? { loading: true } : {})}
            onClick={() => fetcher.submit({ compareAtRule: rule }, { method: "POST" })}>
            Save &amp; resync
          </s-button>
          {settings.lastSyncAt && <s-paragraph>Last successful sync: {new Date(settings.lastSyncAt).toLocaleString()}</s-paragraph>}
        </s-stack>
      </s-section>
      <s-section heading="Discount coverage">
        <s-stack direction="block" gap="base">
          <s-banner tone="warning" heading="Other discounts need their own exclusions">
            This setting creates unpublished protected copies of native discount collections,
            preserving their original product selection and discount percentage.
            Shopify does not provide a global per-product block for every discount.
            Order-wide and third-party automatic discounts must be reviewed separately.
            Third-party app discounts are not overridden, and mixed carts are not blocked.
          </s-banner>
          {coverageError ? (
            <s-banner tone="critical" heading="Coverage could not be verified">{coverageError}</s-banner>
          ) : (
            <>
              <s-paragraph>{coverage.length} active discounts checked; {needsReview.length} need review.</s-paragraph>
              {coverage.map(row => (
                <s-box key={row.id} padding="base" border="base" borderRadius="base">
                  <s-stack direction="block" gap="small">
                    <s-link href={`shopify://admin/discounts/${row.id}`}>{row.title}</s-link>
                    <s-badge tone={row.covered ? "success" : row.shippingOnly ? "info" : "warning"}>
                      {row.covered ? "Uses selected rule" : row.shippingOnly ? "Shipping only" : "Needs review"}
                    </s-badge>
                    <s-paragraph>{row.reason}</s-paragraph>
                  </s-stack>
                </s-box>
              ))}
            </>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = args => boundary.headers(args);
