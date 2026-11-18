import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  detachCollection,
  getSettings,
  listSales,
  log,
  parseSaleWorkbook,
  refreshTimezone,
  replaceSales,
  scanCatalogChunk,
  syncShop,
  type ParsedSale,
  type SaleToSave,
} from "../models/sale-calendar.server";
import {
  buildCatalogIndex,
  dateProblem,
  formatInZone,
  matchProduct,
  parseSheetDate,
  saleStatus,
  toInputValue,
  zonedToUtc,
  type CatalogRow,
  type SaleStatus,
} from "../lib/sale-calendar";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  await getSettings(shop);
  const timezone = await refreshTimezone(admin, shop).catch(async () => (await getSettings(shop)).timezone);
  const settings = await getSettings(shop);
  const [sales, logs] = await Promise.all([
    listSales(shop),
    prisma.saleSyncLog.findMany({ where: { shop }, orderBy: { at: "desc" }, take: 20 }),
  ]);
  return {
    timezone,
    settings: {
      collectionId: settings.collectionId,
      collectionTitle: settings.collectionTitle,
      reorder: settings.reorder,
      lastSyncAt: settings.lastSyncAt?.toISOString() ?? null,
      lastSyncMessage: settings.lastSyncMessage,
    },
    sales,
    logs: logs.map((l) => ({ id: l.id, at: l.at.toISOString(), message: l.message })),
  };
};

async function syncAfterChange(admin: Parameters<typeof syncShop>[0], shop: string) {
  try {
    return (await syncShop(admin, shop)).message;
  } catch (error) {
    return `Sync failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  try {
    if (intent === "parse") {
      const file = formData.get("file");
      if (!(file instanceof File) || !file.size) return { intent, error: "Choose an .xlsx file." };
      if (file.size > MAX_UPLOAD_BYTES) return { intent, error: "File is larger than 10 MB." };
      const timezone = (await getSettings(shop)).timezone;
      const sales = parseSaleWorkbook(Buffer.from(await file.arrayBuffer()), timezone);
      if (!sales.length) return { intent, error: "No sales found in the sheet." };
      return { intent, sales, fileName: file.name };
    }

    if (intent === "scan") {
      const cursor = String(formData.get("cursor") ?? "") || null;
      return { intent, ...(await scanCatalogChunk(admin, cursor)) };
    }

    if (intent === "save") {
      const sales: SaleToSave[] = JSON.parse(String(formData.get("sales") ?? "[]"));
      await replaceSales(shop, sales);
      await log(shop, `Uploaded sheet with ${sales.length} sales.`);
      return { intent, ok: true, message: await syncAfterChange(admin, shop) };
    }

    if (intent === "setCollection") {
      const collectionId = String(formData.get("collectionId") ?? "");
      const collectionTitle = String(formData.get("collectionTitle") ?? "");
      if (!collectionId) return { intent, error: "Choose a collection." };
      const settings = await getSettings(shop);
      if (settings.collectionId && settings.collectionId !== collectionId) {
        await detachCollection(admin, shop);
      }
      await prisma.saleSettings.update({
        where: { shop },
        data: { collectionId, collectionTitle, needsReorder: true },
      });
      await log(shop, `Collection set to "${collectionTitle}".`);
      return { intent, ok: true, message: await syncAfterChange(admin, shop) };
    }

    if (intent === "setReorder") {
      const reorder = formData.get("reorder") === "true";
      await prisma.saleSettings.update({
        where: { shop },
        data: { reorder, needsReorder: reorder },
      });
      return { intent, ok: true, message: await syncAfterChange(admin, shop) };
    }

    if (intent === "updateDates") {
      const id = Number(formData.get("id"));
      const timezone = (await getSettings(shop)).timezone;
      const toDate = (value: FormDataEntryValue | null) => {
        const wall = parseSheetDate(String(value ?? ""));
        return wall ? zonedToUtc(wall, timezone) : null;
      };
      const startsAt = toDate(formData.get("startsAt"));
      const endsAt = toDate(formData.get("endsAt"));
      const problem = dateProblem(startsAt?.toISOString() ?? null, endsAt?.toISOString() ?? null);
      if (problem) return { intent, error: problem };
      const sale = await prisma.sale.findFirst({ where: { id, shop } });
      if (!sale) return { intent, error: "Sale not found." };
      await prisma.sale.update({ where: { id }, data: { startsAt, endsAt } });
      await log(
        shop,
        `Dates changed for "${sale.name}": ${formatInZone(startsAt!.toISOString(), timezone)} – ${formatInZone(endsAt!.toISOString(), timezone)}.`,
      );
      return { intent, ok: true, message: await syncAfterChange(admin, shop) };
    }

    if (intent === "deleteSale") {
      const id = Number(formData.get("id"));
      const sale = await prisma.sale.findFirst({ where: { id, shop } });
      if (!sale) return { intent, error: "Sale not found." };
      await prisma.sale.delete({ where: { id } });
      await log(shop, `Deleted sale "${sale.name}".`);
      return { intent, ok: true, message: await syncAfterChange(admin, shop) };
    }

    if (intent === "sync") {
      return { intent, ok: true, message: (await syncShop(admin, shop)).message };
    }

    return { intent, error: "Unknown action." };
  } catch (error) {
    return { intent, error: error instanceof Error ? error.message : String(error) };
  }
};

type ActionData = {
  intent: string;
  error?: string;
  ok?: boolean;
  message?: string;
  sales?: ParsedSale[];
  fileName?: string;
  rows?: CatalogRow[];
  nextCursor?: string | null;
};

const STATUS_LABEL: Record<SaleStatus, string> = {
  upcoming: "Upcoming",
  live: "Live",
  ended: "Ended",
  invalid: "Fix dates",
};

const STATUS_TONE: Record<SaleStatus, "info" | "success" | "neutral" | "critical"> = {
  upcoming: "info",
  live: "success",
  ended: "neutral",
  invalid: "critical",
};

function relative(iso: string, now: number) {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const text = days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

const inputStyle = {
  padding: "6px 8px",
  border: "1px solid #8a8a8a",
  borderRadius: "8px",
  font: "inherit",
};

export default function SaleCalendar() {
  const { timezone, settings, sales, logs } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const mutate = useFetcher<ActionData>();
  const parseFetcher = useFetcher<ActionData>();
  const scanFetcher = useFetcher<ActionData>();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Refresh statuses from the server every minute (background sync may change them).
  useEffect(() => {
    const t = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 60000);
    return () => clearInterval(t);
  }, [revalidator]);

  // ---- Generic mutations ----
  const lastMutate = useRef<ActionData | undefined>(undefined);
  useEffect(() => {
    const data = mutate.data;
    if (mutate.state !== "idle" || !data || data === lastMutate.current) return;
    lastMutate.current = data;
    if (data.error) shopify.toast.show(data.error, { isError: true });
    else if (data.message) shopify.toast.show(data.message);
    if (data.intent === "updateDates" && data.ok) setEditing(null);
    if (data.intent === "save" && data.ok) {
      setParsed(null);
      setCatalog(null);
    }
  }, [mutate.state, mutate.data, shopify]);
  const busy = mutate.state !== "idle";

  const submit = (data: Record<string, string>) => mutate.submit(data, { method: "post" });

  // ---- Collection ----
  const chooseCollection = async () => {
    const picked = await shopify.resourcePicker({ type: "collection", action: "select" });
    const collection = picked?.[0] as { id: string; title: string } | undefined;
    if (!collection) return;
    submit({
      intent: "setCollection",
      collectionId: collection.id,
      collectionTitle: collection.title,
    });
  };

  // ---- Upload: parse sheet, then scan catalog and match names ----
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ sales: ParsedSale[]; fileName: string } | null>(null);
  const [catalog, setCatalog] = useState<CatalogRow[] | null>(null);
  const [scanCount, setScanCount] = useState<number | null>(null);
  const rowsRef = useRef<CatalogRow[]>([]);
  const lastParse = useRef<ActionData | undefined>(undefined);
  const lastScan = useRef<ActionData | undefined>(undefined);

  const readSheet = () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      shopify.toast.show("Choose an .xlsx file", { isError: true });
      return;
    }
    const form = new FormData();
    form.append("intent", "parse");
    form.append("file", file);
    setParsed(null);
    setCatalog(null);
    parseFetcher.submit(form, { method: "post", encType: "multipart/form-data" });
  };

  useEffect(() => {
    const data = parseFetcher.data;
    if (parseFetcher.state !== "idle" || !data || data === lastParse.current) return;
    lastParse.current = data;
    if (data.error) {
      shopify.toast.show(data.error, { isError: true });
      return;
    }
    setParsed({ sales: data.sales ?? [], fileName: data.fileName ?? "" });
    rowsRef.current = [];
    setScanCount(0);
    scanFetcher.submit({ intent: "scan", cursor: "" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parseFetcher.state, parseFetcher.data]);

  useEffect(() => {
    const data = scanFetcher.data;
    if (scanFetcher.state !== "idle" || !data || data === lastScan.current) return;
    lastScan.current = data;
    if (data.error) {
      setScanCount(null);
      shopify.toast.show(data.error, { isError: true });
      return;
    }
    rowsRef.current.push(...(data.rows ?? []));
    setScanCount(rowsRef.current.length);
    if (data.nextCursor) {
      scanFetcher.submit({ intent: "scan", cursor: data.nextCursor }, { method: "post" });
    } else {
      setCatalog(rowsRef.current);
      setScanCount(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanFetcher.state, scanFetcher.data]);

  const preview = useMemo(() => {
    if (!parsed || !catalog) return null;
    const index = buildCatalogIndex(catalog);
    return parsed.sales.map((sale) => {
      const products: { id: string; title: string }[] = [];
      const seen = new Set<string>();
      const unmatched: string[] = [];
      for (const item of sale.items) {
        const id = matchProduct(index, item.name, item.productId);
        if (!id) {
          unmatched.push(item.name || item.productId || "");
        } else if (!seen.has(id)) {
          seen.add(id);
          products.push({ id, title: index.titles.get(id) ?? item.name });
        }
      }
      return { ...sale, products, unmatched, matchedRows: sale.items.length - unmatched.length };
    });
  }, [parsed, catalog]);

  const saveSales = () => {
    if (!preview) return;
    const payload: SaleToSave[] = preview.map((s) => ({
      name: s.name,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      tab: s.tab,
      products: s.products,
      unmatched: s.unmatched,
    }));
    submit({ intent: "save", sales: JSON.stringify(payload) });
  };

  // ---- Edit dates ----
  const [editing, setEditing] = useState<{ id: number; startsAt: string; endsAt: string } | null>(
    null,
  );

  const scanning = scanCount !== null;
  const reading = parseFetcher.state !== "idle";

  const counts = sales.reduce(
    (acc, s) => {
      acc[saleStatus(s.startsAt, s.endsAt, new Date(now))] += 1;
      return acc;
    },
    { upcoming: 0, live: 0, ended: 0, invalid: 0 } as Record<SaleStatus, number>,
  );

  return (
    <s-page heading="Sale Calendar">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-section heading="1. Collection">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Products of a live sale are added to this collection, and removed after the
            sale ends. Nothing else in the store is changed. Products you added to the
            collection yourself always stay.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Collection: </s-text>
            {settings.collectionTitle ?? "None selected"}
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button onClick={chooseCollection} disabled={busy}>
              {settings.collectionId ? "Change collection" : "Choose collection"}
            </s-button>
          </s-stack>
          <s-checkbox
            label="Show products in sale order (first sale's products, then the next sale's)"
            details="Sets the collection's sort to Manual and puts live sale products first, in sheet order."
            checked={settings.reorder}
            disabled={busy}
            onChange={(e: Event) =>
              submit({
                intent: "setReorder",
                reorder: String((e.target as HTMLInputElement).checked),
              })
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="2. Upload sale sheet">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Upload the .xlsx with a &quot;Sale name / Start Date / End Date / Product Name
            sheet&quot; tab. Each sale&apos;s &quot;Products&quot; link points to its products
            tab. Dates are read in the store time zone ({timezone}). Saving replaces all
            current sales.
          </s-paragraph>
          <input ref={fileRef} type="file" accept=".xlsx" />
          <s-stack direction="inline" gap="base">
            <s-button
              onClick={readSheet}
              disabled={busy || scanning}
              {...(reading ? { loading: true } : {})}
            >
              Read sheet
            </s-button>
          </s-stack>
          {scanning && (
            <s-banner tone="info">
              Matching products… {scanCount} store variants checked.
            </s-banner>
          )}

          {preview && (
            <s-stack direction="block" gap="base">
              <s-heading>Preview: {parsed?.fileName}</s-heading>
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Sale</s-table-header>
                  <s-table-header>Start</s-table-header>
                  <s-table-header>End</s-table-header>
                  <s-table-header>Products</s-table-header>
                  <s-table-header>Problems</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {preview.map((s, i) => (
                    <s-table-row key={i}>
                      <s-table-cell>{s.name}</s-table-cell>
                      <s-table-cell>{formatInZone(s.startsAt, timezone)}</s-table-cell>
                      <s-table-cell>{formatInZone(s.endsAt, timezone)}</s-table-cell>
                      <s-table-cell>
                        {s.products.length} products ({s.matchedRows}/{s.items.length} rows
                        matched)
                      </s-table-cell>
                      <s-table-cell>
                        {[
                          ...s.problems,
                          ...(s.unmatched.length ? [`${s.unmatched.length} names not found`] : []),
                        ].join("; ") || "—"}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
              {preview.some((s) => s.unmatched.length) && (
                <details>
                  <summary>Names not found in the store</summary>
                  <ul>
                    {preview.flatMap((s) =>
                      s.unmatched.map((n, i) => (
                        <li key={`${s.name}-${i}`}>
                          {s.name}: {n}
                        </li>
                      )),
                    )}
                  </ul>
                </details>
              )}
              {preview.some((s) => s.problems.length) && (
                <s-banner tone="warning">
                  Sales with date problems are saved but never run until you fix their dates
                  below.
                </s-banner>
              )}
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" onClick={saveSales} disabled={busy}>
                  Save {preview.length} sales
                </s-button>
                <s-button
                  onClick={() => {
                    setParsed(null);
                    setCatalog(null);
                  }}
                >
                  Cancel
                </s-button>
              </s-stack>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="3. Sales">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {sales.length
              ? `${counts.live} live, ${counts.upcoming} upcoming, ${counts.ended} ended${counts.invalid ? `, ${counts.invalid} need dates` : ""}. Times in ${timezone}.`
              : "No sales yet. Upload the sheet above."}
          </s-paragraph>
          {sales.length > 0 && (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Sale</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Start</s-table-header>
                <s-table-header>End</s-table-header>
                <s-table-header>Products</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {sales.map((s) => {
                  const status = saleStatus(s.startsAt, s.endsAt, new Date(now));
                  const isEditing = editing?.id === s.id;
                  const when =
                    status === "upcoming"
                      ? `Starts ${relative(s.startsAt!, now)}`
                      : status === "live"
                        ? `Ends ${relative(s.endsAt!, now)}`
                        : status === "ended"
                          ? `Ended ${relative(s.endsAt!, now)}`
                          : dateProblem(s.startsAt, s.endsAt);
                  return (
                    <s-table-row key={s.id}>
                      <s-table-cell>{s.name}</s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-200">
                          <s-badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</s-badge>
                          <s-text>{when}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        {isEditing ? (
                          <input
                            type="datetime-local"
                            style={inputStyle}
                            value={editing.startsAt}
                            onChange={(e) => setEditing({ ...editing, startsAt: e.target.value })}
                          />
                        ) : (
                          formatInZone(s.startsAt, timezone)
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {isEditing ? (
                          <input
                            type="datetime-local"
                            style={inputStyle}
                            value={editing.endsAt}
                            onChange={(e) => setEditing({ ...editing, endsAt: e.target.value })}
                          />
                        ) : (
                          formatInZone(s.endsAt, timezone)
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {s.products.length}
                        {s.unmatched.length ? ` (${s.unmatched.length} not found)` : ""}
                      </s-table-cell>
                      <s-table-cell>
                        {isEditing ? (
                          <s-stack direction="inline" gap="small-200">
                            <s-button
                              variant="primary"
                              disabled={busy}
                              onClick={() =>
                                submit({
                                  intent: "updateDates",
                                  id: String(s.id),
                                  startsAt: editing.startsAt,
                                  endsAt: editing.endsAt,
                                })
                              }
                            >
                              Save
                            </s-button>
                            <s-button onClick={() => setEditing(null)}>Cancel</s-button>
                          </s-stack>
                        ) : (
                          <s-stack direction="inline" gap="small-200">
                            <s-button
                              disabled={busy}
                              onClick={() =>
                                setEditing({
                                  id: s.id,
                                  startsAt: toInputValue(s.startsAt, timezone),
                                  endsAt: toInputValue(s.endsAt, timezone),
                                })
                              }
                            >
                              Edit dates
                            </s-button>
                            <s-button
                              tone="critical"
                              variant="tertiary"
                              disabled={busy}
                              onClick={() => {
                                if (confirm(`Delete "${s.name}"?`)) {
                                  submit({ intent: "deleteSale", id: String(s.id) });
                                }
                              }}
                            >
                              Delete
                            </s-button>
                          </s-stack>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>

      <s-section heading="4. Sync">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The app checks every 5 minutes and adds or removes products on time. Last
            check:{" "}
            {settings.lastSyncAt
              ? `${formatInZone(settings.lastSyncAt, timezone)} — ${settings.lastSyncMessage ?? ""}`
              : "never"}
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button
              onClick={() => submit({ intent: "sync" })}
              disabled={!settings.collectionId}
              {...(busy ? { loading: true } : {})}
            >
              Sync now
            </s-button>
          </s-stack>
          {logs.length > 0 && (
            <s-table>
              <s-table-header-row>
                <s-table-header>When</s-table-header>
                <s-table-header listSlot="primary">What happened</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {logs.map((l) => (
                  <s-table-row key={l.id}>
                    <s-table-cell>{formatInZone(l.at, timezone)}</s-table-cell>
                    <s-table-cell>{l.message}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
