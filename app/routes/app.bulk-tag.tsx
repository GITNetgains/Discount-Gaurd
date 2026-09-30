import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  applyTag,
  findProducts,
  listVendors,
  type MatchedProduct,
} from "../models/bulk-tag.server";

const DEFAULT_TAG = "MAP Restricted";
const APPLY_CHUNK_SIZE = 50;
const PREVIEW_ROWS = 100;

function fieldValue(event: Event) {
  return (event.target as HTMLInputElement).value;
}

function checkboxChecked(event: Event) {
  return (event.target as HTMLInputElement).checked;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  return { vendors: await listVendors(admin) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  try {
    if (intent === "find") {
      const products = await findProducts(admin, {
        vendors: JSON.parse(String(formData.get("vendors") ?? "[]")),
        onSaleOnly: formData.get("onSaleOnly") === "true",
        tag: String(formData.get("tag") ?? ""),
      });
      return { intent, products };
    }

    if (intent === "add" || intent === "remove") {
      const ids: string[] = JSON.parse(String(formData.get("ids") ?? "[]"));
      const tag = String(formData.get("tag") ?? "").trim();
      if (!tag) return { intent, error: "Tag is required." };
      const failures = await applyTag(admin, ids, tag, intent);
      return { intent, processed: ids.length, failures };
    }

    return { intent, error: "Unknown action." };
  } catch (error) {
    return { intent, error: error instanceof Error ? error.message : String(error) };
  }
};

type ActionData = {
  intent: string;
  error?: string;
  products?: MatchedProduct[];
  processed?: number;
  failures?: { id: string; message: string }[];
};

export default function BulkTag() {
  const { vendors } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const findFetcher = useFetcher<ActionData>();
  const applyFetcher = useFetcher<ActionData>();

  const [tag, setTag] = useState(DEFAULT_TAG);
  const [vendorSearch, setVendorSearch] = useState("");
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [onSaleOnly, setOnSaleOnly] = useState(false);

  const [products, setProducts] = useState<MatchedProduct[] | null>(null);
  const [progress, setProgress] = useState<{
    mode: "add" | "remove";
    done: number;
    total: number;
    failures: number;
  } | null>(null);
  const queueRef = useRef<string[]>([]);
  const lastApplyData = useRef<ActionData | undefined>(undefined);

  const visibleVendors = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase();
    return q ? vendors.filter((v) => v.toLowerCase().includes(q)) : vendors;
  }, [vendors, vendorSearch]);

  const finding = findFetcher.state !== "idle";
  const applying = progress !== null && progress.done < progress.total;

  useEffect(() => {
    const data = findFetcher.data;
    if (!data || data.intent !== "find") return;
    if (data.error) shopify.toast.show(data.error, { isError: true });
    else setProducts(data.products ?? []);
  }, [findFetcher.data, shopify]);

  const submitNextChunk = (mode: "add" | "remove") => {
    const chunk = queueRef.current.splice(0, APPLY_CHUNK_SIZE);
    applyFetcher.submit(
      { intent: mode, tag: tag.trim(), ids: JSON.stringify(chunk) },
      { method: "post" },
    );
  };

  // Drive the chunked add/remove: each finished chunk submits the next one.
  useEffect(() => {
    const data = applyFetcher.data;
    if (applyFetcher.state !== "idle" || !data || data === lastApplyData.current) return;
    lastApplyData.current = data;
    if (!progress) return;

    if (data.error) {
      queueRef.current = [];
      setProgress(null);
      shopify.toast.show(data.error, { isError: true });
      return;
    }

    const next = {
      ...progress,
      done: progress.done + (data.processed ?? 0),
      failures: progress.failures + (data.failures?.length ?? 0),
    };
    setProgress(next);

    if (queueRef.current.length) {
      submitNextChunk(progress.mode);
    } else {
      shopify.toast.show(
        `${progress.mode === "add" ? "Tagged" : "Untagged"} ${next.done - next.failures} products` +
          (next.failures ? `, ${next.failures} failed` : ""),
        next.failures ? { isError: true } : undefined,
      );
      // Refresh the preview so the "Has tag" column is current.
      handleFind();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyFetcher.state, applyFetcher.data]);

  const handleFind = () => {
    if (!selectedVendors.length && !onSaleOnly) {
      shopify.toast.show("Select at least one vendor or the compare-at price filter", {
        isError: true,
      });
      return;
    }
    findFetcher.submit(
      {
        intent: "find",
        tag: tag.trim(),
        vendors: JSON.stringify(selectedVendors),
        onSaleOnly: String(onSaleOnly),
      },
      { method: "post" },
    );
  };

  const handleApply = (mode: "add" | "remove") => {
    if (!tag.trim()) {
      shopify.toast.show("Enter a tag", { isError: true });
      return;
    }
    if (!products?.length) return;
    const ids = products
      .filter((p) => (mode === "add" ? !p.hasTag : p.hasTag))
      .map((p) => p.id);
    if (!ids.length) {
      shopify.toast.show(
        mode === "add" ? "All matched products already have this tag" : "No matched products have this tag",
      );
      return;
    }
    queueRef.current = [...ids];
    setProgress({ mode, done: 0, total: ids.length, failures: 0 });
    submitNextChunk(mode);
  };

  const toggleVendor = (vendor: string, checked: boolean) =>
    setSelectedVendors((prev) =>
      checked ? [...prev, vendor] : prev.filter((v) => v !== vendor),
    );

  const taggedCount = products?.filter((p) => p.hasTag).length ?? 0;
  const onSaleCount = products?.filter((p) => p.onSale).length ?? 0;

  return (
    <s-page heading="Bulk tag products">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-section heading="1. Tag">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Tag to add or remove"
            value={tag}
            onChange={(e: Event) => setTag(fieldValue(e))}
            details={`Discount Guard excludes products tagged "${DEFAULT_TAG}".`}
          />
        </s-stack>
      </s-section>

      <s-section heading="2. Filter products">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Selected vendors ({selectedVendors.length}):{" "}
            {selectedVendors.length ? selectedVendors.join(", ") : "none"}
          </s-paragraph>
          <s-text-field
            label="Search vendors"
            value={vendorSearch}
            onChange={(e: Event) => setVendorSearch(fieldValue(e))}
          />
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            maxBlockSize="300px"
            overflow="hidden"
          >
            <div style={{ maxHeight: "280px", overflowY: "auto" }}>
              <s-stack direction="block" gap="small-200">
                {visibleVendors.map((vendor) => (
                  <s-checkbox
                    key={vendor}
                    label={vendor}
                    checked={selectedVendors.includes(vendor)}
                    onChange={(e: Event) => toggleVendor(vendor, checkboxChecked(e))}
                  />
                ))}
                {visibleVendors.length === 0 && (
                  <s-paragraph>No vendors match.</s-paragraph>
                )}
              </s-stack>
            </div>
          </s-box>
          <s-checkbox
            label="Only products with a compare-at price (on sale)"
            checked={onSaleOnly}
            onChange={(e: Event) => setOnSaleOnly(checkboxChecked(e))}
            details="With vendors selected, only their on-sale products match. With no vendors, all on-sale products match."
          />
          {onSaleOnly && (
            <s-banner tone="warning">
              Discount Guard already excludes on-sale items automatically. Tagging
              them &quot;{DEFAULT_TAG}&quot; keeps them excluded even after the sale
              ends, until you remove the tag.
            </s-banner>
          )}
          <s-stack direction="inline" gap="base">
            <s-button onClick={handleFind} {...(finding ? { loading: true } : {})}>
              Find products
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      {products && (
        <s-section heading={`3. Matched products (${products.length})`}>
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {taggedCount} already tagged &quot;{tag}&quot;, {onSaleCount} on sale.
            </s-paragraph>

            {progress && (
              <s-banner tone={applying ? "info" : progress.failures ? "warning" : "success"}>
                {progress.mode === "add" ? "Adding" : "Removing"} tag: {progress.done} /{" "}
                {progress.total} done
                {progress.failures ? `, ${progress.failures} failed` : ""}
              </s-banner>
            )}

            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                onClick={() => handleApply("add")}
                disabled={applying || products.length === taggedCount}
                {...(applying && progress?.mode === "add" ? { loading: true } : {})}
              >
                Add tag to {products.length - taggedCount} products
              </s-button>
              <s-button
                tone="critical"
                onClick={() => handleApply("remove")}
                disabled={applying || taggedCount === 0}
                {...(applying && progress?.mode === "remove" ? { loading: true } : {})}
              >
                Remove tag from {taggedCount} products
              </s-button>
            </s-stack>

            {products.length > 0 && (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Product</s-table-header>
                  <s-table-header>Vendor</s-table-header>
                  <s-table-header>On sale</s-table-header>
                  <s-table-header>Has tag</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {products.slice(0, PREVIEW_ROWS).map((p) => (
                    <s-table-row key={p.id}>
                      <s-table-cell>{p.title}</s-table-cell>
                      <s-table-cell>{p.vendor}</s-table-cell>
                      <s-table-cell>{p.onSale ? "Yes" : "No"}</s-table-cell>
                      <s-table-cell>{p.hasTag ? "Yes" : "No"}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            {products.length > PREVIEW_ROWS && (
              <s-paragraph>
                Showing first {PREVIEW_ROWS} of {products.length}. Actions apply to all{" "}
                {products.length}.
              </s-paragraph>
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
