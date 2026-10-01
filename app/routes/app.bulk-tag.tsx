import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  applyTag,
  listVendors,
  scanCatalogChunk,
  type ScannedProduct,
} from "../models/bulk-tag.server";

const DEFAULT_TAG = "MAP Restricted";
const APPLY_CHUNK_SIZE = 50;
const PREVIEW_ROWS = 100;

type CompareMode = "off" | "onSale" | "any";
type TagMode = "add" | "remove";
type PreviewView = "matching" | "toAdd" | "toRemove";

function fieldValue(event: Event) {
  return (event.target as HTMLInputElement).value;
}

function checkboxChecked(event: Event) {
  return (event.target as HTMLInputElement).checked;
}

const normalize = (value: string) => value.trim().toLowerCase();

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  return { vendors: await listVendors(admin) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  try {
    if (intent === "scan") {
      const cursor = String(formData.get("cursor") ?? "") || null;
      return { intent, ...(await scanCatalogChunk(admin, cursor)) };
    }

    if (intent === "add" || intent === "remove") {
      const ids: string[] = JSON.parse(String(formData.get("ids") ?? "[]"));
      const tag = String(formData.get("tag") ?? "").trim();
      if (!tag) return { intent, error: "Tag is required." };
      const failures = await applyTag(admin, ids, tag, intent);
      return { intent, ids, failures };
    }

    return { intent, error: "Unknown action." };
  } catch (error) {
    return { intent, error: error instanceof Error ? error.message : String(error) };
  }
};

type ActionData = {
  intent: string;
  error?: string;
  // scan
  products?: ScannedProduct[];
  variantsScanned?: number;
  nextCursor?: string | null;
  // add / remove
  ids?: string[];
  failures?: { id: string; message: string }[];
};

interface ApplyChunk {
  mode: TagMode;
  ids: string[];
}

export default function BulkTag() {
  const { vendors } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const scanFetcher = useFetcher<ActionData>();
  const applyFetcher = useFetcher<ActionData>();

  const [tag, setTag] = useState(DEFAULT_TAG);
  const [vendorSearch, setVendorSearch] = useState("");
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [compareMode, setCompareMode] = useState<CompareMode>("off");
  const [view, setView] = useState<PreviewView>("matching");
  const [confirmSync, setConfirmSync] = useState(false);

  // Catalog scan: products keyed by id, merged across chunks.
  const catalogRef = useRef(new Map<string, ScannedProduct>());
  const [catalog, setCatalog] = useState<ScannedProduct[] | null>(null);
  const [scan, setScan] = useState<{ running: boolean; variants: number } | null>(null);
  const lastScanData = useRef<ActionData | undefined>(undefined);

  // Chunked add/remove queue.
  const queueRef = useRef<ApplyChunk[]>([]);
  const lastApplyData = useRef<ActionData | undefined>(undefined);
  const [progress, setProgress] = useState<{
    label: string;
    done: number;
    total: number;
    failures: string[];
    running: boolean;
  } | null>(null);

  const visibleVendors = useMemo(() => {
    const q = normalize(vendorSearch);
    return q ? vendors.filter((v) => v.toLowerCase().includes(q)) : vendors;
  }, [vendors, vendorSearch]);

  // ---- Matching (OR across rules), evaluated live on the scanned catalog ----
  const tagKey = normalize(tag);
  const vendorKeys = useMemo(
    () => new Set(selectedVendors.map(normalize)),
    [selectedVendors],
  );
  const hasRules = vendorKeys.size > 0 || compareMode !== "off";

  const { matching, toAdd, toRemove, hasTagCount } = useMemo(() => {
    const matching: (ScannedProduct & { reason: string; hasTag: boolean })[] = [];
    const toAdd: string[] = [];
    const toRemove: (ScannedProduct & { reason: string; hasTag: boolean })[] = [];
    let hasTagCount = 0;

    for (const p of catalog ?? []) {
      const hasTag = !!tagKey && p.tags.some((t) => normalize(t) === tagKey);
      if (hasTag) hasTagCount += 1;

      const reasons: string[] = [];
      if (vendorKeys.has(normalize(p.vendor))) reasons.push("Vendor");
      if (compareMode === "onSale" && p.onSale) reasons.push("Compare-at > price");
      if (compareMode === "any" && p.hasCompareAt) reasons.push("Has compare-at");

      const row = { ...p, reason: reasons.join(", "), hasTag };
      if (reasons.length) {
        matching.push(row);
        if (!hasTag) toAdd.push(p.id);
      } else if (hasTag) {
        toRemove.push({ ...row, reason: "No rule matches" });
      }
    }

    const byVendorTitle = (a: ScannedProduct, b: ScannedProduct) =>
      a.vendor.localeCompare(b.vendor) || a.title.localeCompare(b.title);
    matching.sort(byVendorTitle);
    toRemove.sort(byVendorTitle);
    return { matching, toAdd, toRemove, hasTagCount };
  }, [catalog, tagKey, vendorKeys, compareMode]);

  const matchingWithTag = matching.filter((p) => p.hasTag);
  const applying = !!progress?.running;
  const scanning = !!scan?.running;

  // ---- Scan loop ----
  const startScan = () => {
    catalogRef.current = new Map();
    setCatalog(null);
    setProgress(null);
    setConfirmSync(false);
    setScan({ running: true, variants: 0 });
    scanFetcher.submit({ intent: "scan", cursor: "" }, { method: "post" });
  };

  useEffect(() => {
    const data = scanFetcher.data;
    if (scanFetcher.state !== "idle" || !data || data === lastScanData.current) return;
    lastScanData.current = data;
    if (data.intent !== "scan") return;

    if (data.error) {
      setScan(null);
      shopify.toast.show(data.error, { isError: true });
      return;
    }

    const map = catalogRef.current;
    for (const p of data.products ?? []) {
      const existing = map.get(p.id);
      if (existing) {
        existing.onSale ||= p.onSale;
        existing.hasCompareAt ||= p.hasCompareAt;
      } else {
        map.set(p.id, { ...p });
      }
    }

    const variants = (scan?.variants ?? 0) + (data.variantsScanned ?? 0);
    if (data.nextCursor) {
      setScan({ running: true, variants });
      scanFetcher.submit({ intent: "scan", cursor: data.nextCursor }, { method: "post" });
    } else {
      setScan({ running: false, variants });
      setCatalog([...map.values()]);
      shopify.toast.show(`Scanned ${map.size} products`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanFetcher.state, scanFetcher.data]);

  // ---- Apply loop ----
  const runJobs = (label: string, jobs: ApplyChunk[]) => {
    const chunks: ApplyChunk[] = [];
    for (const job of jobs) {
      for (let i = 0; i < job.ids.length; i += APPLY_CHUNK_SIZE) {
        chunks.push({ mode: job.mode, ids: job.ids.slice(i, i + APPLY_CHUNK_SIZE) });
      }
    }
    const total = chunks.reduce((sum, c) => sum + c.ids.length, 0);
    if (!total) {
      shopify.toast.show("Nothing to change");
      return;
    }
    queueRef.current = chunks;
    setConfirmSync(false);
    setProgress({ label, done: 0, total, failures: [], running: true });
    submitNextChunk();
  };

  const submitNextChunk = () => {
    const chunk = queueRef.current.shift();
    if (!chunk) return;
    applyFetcher.submit(
      { intent: chunk.mode, tag: tag.trim(), ids: JSON.stringify(chunk.ids) },
      { method: "post" },
    );
  };

  useEffect(() => {
    const data = applyFetcher.data;
    if (applyFetcher.state !== "idle" || !data || data === lastApplyData.current) return;
    lastApplyData.current = data;
    if (!progress?.running) return;

    if (data.error) {
      queueRef.current = [];
      setProgress({ ...progress, running: false });
      shopify.toast.show(data.error, { isError: true });
      return;
    }

    // Reflect successful changes in the local catalog so counts stay current.
    const failed = new Set((data.failures ?? []).map((f) => f.id));
    const tagValue = tag.trim();
    for (const id of data.ids ?? []) {
      if (failed.has(id)) continue;
      const p = catalogRef.current.get(id);
      if (!p) continue;
      p.tags =
        data.intent === "add"
          ? [...p.tags, tagValue]
          : p.tags.filter((t) => normalize(t) !== normalize(tagValue));
    }
    setCatalog([...catalogRef.current.values()]);

    const next = {
      ...progress,
      done: progress.done + (data.ids?.length ?? 0),
      failures: [...progress.failures, ...(data.failures ?? []).map((f) => `${f.id}: ${f.message}`)],
    };

    if (queueRef.current.length) {
      setProgress(next);
      submitNextChunk();
    } else {
      setProgress({ ...next, running: false });
      shopify.toast.show(
        `${next.label}: ${next.done - next.failures.length} products updated` +
          (next.failures.length ? `, ${next.failures.length} failed` : ""),
        next.failures.length ? { isError: true } : undefined,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyFetcher.state, applyFetcher.data]);

  const requireTag = () => {
    if (!tag.trim()) {
      shopify.toast.show("Enter a tag", { isError: true });
      return false;
    }
    return true;
  };

  const handleAdd = () => {
    if (!requireTag()) return;
    runJobs("Add tag", [{ mode: "add", ids: toAdd }]);
  };

  const handleRemoveFromMatching = () => {
    if (!requireTag()) return;
    runJobs("Remove tag", [{ mode: "remove", ids: matchingWithTag.map((p) => p.id) }]);
  };

  const handleSync = () => {
    if (!requireTag() || !hasRules) return;
    runJobs("Sync", [
      { mode: "add", ids: toAdd },
      { mode: "remove", ids: toRemove.map((p) => p.id) },
    ]);
  };

  const toggleVendor = (vendor: string, checked: boolean) =>
    setSelectedVendors((prev) =>
      checked ? [...prev, vendor] : prev.filter((v) => v !== vendor),
    );

  const previewRows =
    view === "toRemove"
      ? toRemove
      : view === "toAdd"
        ? matching.filter((p) => !p.hasTag)
        : matching;

  return (
    <s-page heading="Bulk tag products">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-section heading="1. Tag">
        <s-text-field
          label="Tag"
          value={tag}
          onChange={(e: Event) => setTag(fieldValue(e))}
          details={`Discount Guard excludes products tagged "${DEFAULT_TAG}". Tag matching ignores upper/lower case.`}
        />
      </s-section>

      <s-section heading="2. Rules (a product matches if ANY rule matches)">
        <s-stack direction="block" gap="base">
          <s-select
            label="Compare-at price rule"
            value={compareMode}
            onChange={(e: Event) => setCompareMode(fieldValue(e) as CompareMode)}
          >
            <s-option value="off">Off — ignore compare-at price</s-option>
            <s-option value="onSale">
              Compare-at price greater than price (on sale)
            </s-option>
            <s-option value="any">Any compare-at price set</s-option>
          </s-select>

          <s-paragraph>
            Vendors ({selectedVendors.length} selected):{" "}
            {selectedVendors.length ? selectedVendors.join(", ") : "none"}
          </s-paragraph>
          <s-text-field
            label="Search vendors"
            value={vendorSearch}
            onChange={(e: Event) => setVendorSearch(fieldValue(e))}
            details="Vendor matching ignores upper/lower case and extra spaces."
          />
          <s-box padding="base" borderWidth="base" borderRadius="base">
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

          {compareMode !== "off" && tagKey === normalize(DEFAULT_TAG) && (
            <s-banner tone="warning">
              Discount Guard already excludes on-sale items automatically. If you tag
              them &quot;{DEFAULT_TAG}&quot;, run Sync again after sales end so the
              tag is removed from products that no longer have a compare-at price.
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading="3. Scan all products">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Checks every variant of every product in the store (active, draft and
            archived). Rules above can be changed after scanning — results update
            instantly.
          </s-paragraph>
          {scan && (
            <s-banner tone={scan.running ? "info" : "success"}>
              {scan.running
                ? `Scanning… ${scan.variants} variants checked, ${catalogRef.current.size} products so far`
                : `Scan complete: ${catalog?.length ?? 0} products, ${scan.variants} variants. ${hasTagCount} currently tagged "${tag}".`}
            </s-banner>
          )}
          <s-stack direction="inline" gap="base">
            <s-button
              onClick={startScan}
              disabled={applying}
              {...(scanning ? { loading: true } : {})}
            >
              {catalog ? "Rescan all products" : "Scan all products"}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      {catalog && (
        <s-section heading="4. Review and apply">
          <s-stack direction="block" gap="base">
            {!hasRules && (
              <s-banner tone="info">Choose a vendor or a compare-at price rule.</s-banner>
            )}
            <s-unordered-list>
              <s-list-item>Matching products: {matching.length}</s-list-item>
              <s-list-item>
                Matching but missing the tag (will be added): {toAdd.length}
              </s-list-item>
              <s-list-item>
                Tagged but not matching any rule (Sync removes the tag): {toRemove.length}
              </s-list-item>
            </s-unordered-list>

            {progress && (
              <s-banner
                tone={progress.running ? "info" : progress.failures.length ? "warning" : "success"}
                heading={`${progress.label}: ${progress.done} / ${progress.total} products`}
              >
                {progress.running
                  ? "Working… keep this page open."
                  : progress.failures.length
                    ? `Finished with ${progress.failures.length} failures. First: ${progress.failures[0]}`
                    : "Finished. Discount Guard updates eligible products automatically within about a minute."}
              </s-banner>
            )}

            {confirmSync && (
              <s-banner tone="critical" heading="Confirm sync">
                <s-stack direction="block" gap="base">
                  <s-paragraph>
                    Add &quot;{tag}&quot; to {toAdd.length} products and REMOVE it from{" "}
                    {toRemove.length} products that don&apos;t match the rules above —
                    including any tagged by hand.
                  </s-paragraph>
                  <s-stack direction="inline" gap="base">
                    <s-button tone="critical" variant="primary" onClick={handleSync}>
                      Yes, sync now
                    </s-button>
                    <s-button onClick={() => setConfirmSync(false)}>Cancel</s-button>
                  </s-stack>
                </s-stack>
              </s-banner>
            )}

            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                onClick={handleAdd}
                disabled={applying || scanning || toAdd.length === 0}
              >
                Add tag to {toAdd.length} products
              </s-button>
              <s-button
                onClick={() => setConfirmSync(true)}
                disabled={
                  applying || scanning || !hasRules || toAdd.length + toRemove.length === 0
                }
              >
                Sync (add {toAdd.length}, remove {toRemove.length})
              </s-button>
              <s-button
                tone="critical"
                onClick={handleRemoveFromMatching}
                disabled={applying || scanning || matchingWithTag.length === 0}
              >
                Remove tag from {matchingWithTag.length} matching products
              </s-button>
            </s-stack>

            <s-select
              label="Show"
              value={view}
              onChange={(e: Event) => setView(fieldValue(e) as PreviewView)}
            >
              <s-option value="matching">Matching products ({matching.length})</s-option>
              <s-option value="toAdd">Will get the tag ({toAdd.length})</s-option>
              <s-option value="toRemove">
                Sync will remove the tag ({toRemove.length})
              </s-option>
            </s-select>

            {previewRows.length > 0 ? (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Product</s-table-header>
                  <s-table-header>Vendor</s-table-header>
                  <s-table-header>Why</s-table-header>
                  <s-table-header>Compare-at</s-table-header>
                  <s-table-header>Has tag</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {previewRows.slice(0, PREVIEW_ROWS).map((p) => (
                    <s-table-row key={p.id}>
                      <s-table-cell>{p.title}</s-table-cell>
                      <s-table-cell>{p.vendor}</s-table-cell>
                      <s-table-cell>{p.reason}</s-table-cell>
                      <s-table-cell>
                        {p.onSale ? "On sale" : p.hasCompareAt ? "Set" : "—"}
                      </s-table-cell>
                      <s-table-cell>{p.hasTag ? "Yes" : "No"}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <s-paragraph>No products in this list.</s-paragraph>
            )}
            {previewRows.length > PREVIEW_ROWS && (
              <s-paragraph>
                Showing first {PREVIEW_ROWS} of {previewRows.length}. Actions apply to all
                of them.
              </s-paragraph>
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
