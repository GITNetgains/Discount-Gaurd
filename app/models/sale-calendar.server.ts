import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { readWorkbook, type SheetCell } from "./xlsx.server";
import {
  dateProblem,
  parseSheetDate,
  saleStatus,
  zonedToUtc,
  type CatalogRow,
} from "../lib/sale-calendar";

// Sale Calendar: the merchant picks ONE collection and uploads the holiday
// sale sheet. While a sale is live its products are in that collection; after
// it ends they are removed. The app only ever touches its own source inside
// that collection — products the merchant added there themselves, and every
// other part of the store, are left alone.

type Admin = Pick<AdminApiContext, "graphql">;

const APP_SOURCE_TITLE = "Sale Calendar (managed by app)";
const SELECTION_BATCH = 250;
const MOVE_BATCH = 250;
const SCAN_PAGES_PER_CHUNK = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql<T>(admin: Admin, query: string, variables?: Record<string, unknown>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await admin.graphql(query, variables ? { variables } : undefined);
      const json = (await response.json()) as { data?: T; errors?: unknown };
      if (Array.isArray(json.errors) && json.errors.length) {
        throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "));
      }
      if (!json.data) throw new Error("Admin API returned no data.");
      return json.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/throttl/i.test(message) && attempt < 5) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

function userErrors(errors: { message: string }[] | undefined) {
  if (errors?.length) throw new Error(errors.map((e) => e.message).join("; "));
}

// ---------------------------------------------------------------------------
// Sheet parsing

export interface ParsedItem {
  name: string;
  productId?: string;
}

export interface ParsedSale {
  name: string;
  startText: string;
  endText: string;
  startsAt: string | null;
  endsAt: string | null;
  tab: string | null;
  items: ParsedItem[];
  problems: string[];
}

const clean = (s: string | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();

function columnOf(ref: string) {
  return ref.replace(/\d+$/, "");
}

function rowOf(ref: string) {
  return Number(ref.replace(/^[A-Z]+/, ""));
}

/** Finds header columns in row 1 by (case-insensitive) header text. */
function headerColumns(cells: Map<string, SheetCell>) {
  const headers = new Map<string, string>();
  for (const [ref, cell] of cells) {
    if (rowOf(ref) === 1) headers.set(clean(cell.value).toLowerCase(), columnOf(ref));
  }
  const find = (...needles: string[]) => {
    for (const [text, col] of headers) {
      if (needles.some((n) => text.includes(n))) return col;
    }
    return null;
  };
  return { find };
}

/** "'Garmin '!A1" / "#Tethrd!A1" -> tab name. */
function linkedTab(link: string | undefined, sheetNames: string[]) {
  if (!link) return null;
  const target = link.replace(/^#/, "");
  const m = target.match(/^'((?:[^']|'')+)'!/) ?? target.match(/^([^!]+)!/);
  if (!m) return null;
  const name = m[1].replace(/''/g, "'");
  return sheetNames.find((s) => s === name) ?? sheetNames.find((s) => s.trim() === name.trim()) ?? null;
}

export function parseSaleWorkbook(buffer: Buffer, timeZone: string): ParsedSale[] {
  const { sheetNames, sheets } = readWorkbook(buffer);

  // The calendar tab is the one with a "Sale name" header.
  const calendarName = sheetNames.find((name) => {
    const { find } = headerColumns(sheets.get(name)!);
    return find("sale name") !== null;
  });
  if (!calendarName) {
    throw new Error('No tab with a "Sale name" column was found in this sheet.');
  }
  const calendar = sheets.get(calendarName)!;
  const { find } = headerColumns(calendar);
  const nameCol = find("sale name")!;
  const startCol = find("start");
  const endCol = find("end");
  // "Product Name sheet" (not "Number of products").
  const productsCol = find("product name", "product sheet", "products sheet") ?? find("products link");

  const rows = [...new Set([...calendar.keys()].map(rowOf))]
    .filter((r) => r > 1)
    .sort((a, b) => a - b);

  const sales: ParsedSale[] = [];
  for (const r of rows) {
    const name = clean(calendar.get(`${nameCol}${r}`)?.value);
    if (!name) continue;
    const startText = startCol ? clean(calendar.get(`${startCol}${r}`)?.value) : "";
    const endText = endCol ? clean(calendar.get(`${endCol}${r}`)?.value) : "";
    const start = parseSheetDate(startText);
    const end = parseSheetDate(endText);
    const startsAt = start ? zonedToUtc(start, timeZone).toISOString() : null;
    const endsAt = end ? zonedToUtc(end, timeZone).toISOString() : null;

    const problems: string[] = [];
    if (startText && !start) problems.push(`Could not read start date "${startText}"`);
    if (endText && !end) problems.push(`Could not read end date "${endText}"`);
    const dateIssue = dateProblem(startsAt, endsAt);
    if (dateIssue && !problems.length) problems.push(dateIssue);

    // Products tab: from the "Products" link, else a tab with the same name.
    const linkCell = productsCol ? calendar.get(`${productsCol}${r}`) : undefined;
    const tab =
      linkedTab(linkCell?.link, sheetNames) ??
      sheetNames.find((s) => s !== calendarName && s.trim().toLowerCase() === name.toLowerCase()) ??
      null;

    const items: ParsedItem[] = [];
    if (tab) {
      const cells = sheets.get(tab)!;
      const cols = headerColumns(cells);
      const itemCol = cols.find("product name", "product title", "name", "title") ?? "B";
      const idCol = cols.find("product id");
      const itemRows = [...new Set([...cells.keys()].map(rowOf))]
        .filter((x) => x > 1)
        .sort((a, b) => a - b);
      for (const ir of itemRows) {
        const itemName = clean(cells.get(`${itemCol}${ir}`)?.value);
        const productId = idCol ? clean(cells.get(`${idCol}${ir}`)?.value) : "";
        if (!itemName && !productId) continue;
        items.push({ name: itemName, ...(productId ? { productId } : {}) });
      }
    } else {
      problems.push("Products tab not found");
    }
    if (tab && !items.length) problems.push("Products tab is empty");

    sales.push({
      name: name.replace(/\s+/g, " "),
      startText,
      endText,
      startsAt,
      endsAt,
      tab,
      items,
      problems,
    });
  }
  return sales;
}

// ---------------------------------------------------------------------------
// Catalog scan (chunked so no single request runs long)

const CATALOG_VARIANTS = `#graphql
  query SaleCalendarVariants($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { title product { id title } }
    }
  }
`;

export async function scanCatalogChunk(admin: Admin, startCursor: string | null) {
  const rows: CatalogRow[] = [];
  let cursor = startCursor;
  for (let page = 0; page < SCAN_PAGES_PER_CHUNK; page += 1) {
    const data = await gql<{
      productVariants: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { title: string; product: { id: string; title: string } }[];
      };
    }>(admin, CATALOG_VARIANTS, { cursor });
    for (const v of data.productVariants.nodes) rows.push([v.product.id, v.product.title, v.title]);
    cursor = data.productVariants.pageInfo.hasNextPage
      ? data.productVariants.pageInfo.endCursor
      : null;
    if (!cursor) break;
  }
  return { rows, nextCursor: cursor };
}

// ---------------------------------------------------------------------------
// Settings and storage

const SHOP_TIMEZONE = `#graphql
  query SaleCalendarShop { shop { ianaTimezone } }
`;

export async function getSettings(shop: string) {
  return (
    (await prisma.saleSettings.findUnique({ where: { shop } })) ??
    (await prisma.saleSettings.create({ data: { shop } }))
  );
}

export async function refreshTimezone(admin: Admin, shop: string) {
  const data = await gql<{ shop: { ianaTimezone: string } }>(admin, SHOP_TIMEZONE);
  const timezone = data.shop.ianaTimezone || "UTC";
  await prisma.saleSettings.upsert({
    where: { shop },
    create: { shop, timezone },
    update: { timezone },
  });
  return timezone;
}

export async function log(shop: string, message: string) {
  await prisma.saleSyncLog.create({ data: { shop, message } });
  // Keep the log short.
  const old = await prisma.saleSyncLog.findMany({
    where: { shop },
    orderBy: { at: "desc" },
    skip: 200,
    select: { id: true },
  });
  if (old.length) {
    await prisma.saleSyncLog.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }
}

export interface SaleToSave {
  name: string;
  startsAt: string | null;
  endsAt: string | null;
  tab: string | null;
  products: { id: string; title: string }[];
  unmatched: string[];
}

/** Replaces every sale of the shop with the uploaded ones. */
export async function replaceSales(shop: string, sales: SaleToSave[]) {
  await prisma.$transaction(async (tx) => {
    await tx.sale.deleteMany({ where: { shop } });
    for (const [position, sale] of sales.entries()) {
      const seen = new Set<string>();
      const products = sale.products.filter((p) => !seen.has(p.id) && seen.add(p.id));
      await tx.sale.create({
        data: {
          shop,
          name: sale.name,
          startsAt: sale.startsAt ? new Date(sale.startsAt) : null,
          endsAt: sale.endsAt ? new Date(sale.endsAt) : null,
          position,
          sheetTab: sale.tab,
          unmatched: JSON.stringify(sale.unmatched),
          products: {
            create: products.map((p, i) => ({ productId: p.id, title: p.title, position: i })),
          },
        },
      });
    }
  });
}

export async function listSales(shop: string) {
  const sales = await prisma.sale.findMany({
    where: { shop },
    orderBy: { position: "asc" },
    include: { products: { orderBy: { position: "asc" } } },
  });
  return sales.map((s) => ({
    id: s.id,
    name: s.name,
    startsAt: s.startsAt?.toISOString() ?? null,
    endsAt: s.endsAt?.toISOString() ?? null,
    tab: s.sheetTab,
    products: s.products.map((p) => ({ id: p.productId, title: p.title })),
    unmatched: JSON.parse(s.unmatched) as string[],
  }));
}

// ---------------------------------------------------------------------------
// Sync: make the app's source hold exactly the products of live sales.

const COLLECTION_STATE = `#graphql
  query SaleCalendarCollection($id: ID!) {
    collection(id: $id) {
      id
      title
      sortOrder
      sources {
        __typename
        id
        title
      }
    }
  }
`;

const SOURCE_SELECTIONS = `#graphql
  query SaleCalendarSelections($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on CollectionConditionsSource {
        inclusion {
          selections(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { product { id } }
          }
        }
      }
    }
  }
`;

const UPDATE_COLLECTION = `#graphql
  mutation SaleCalendarUpdate($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) {
      collection { id sources { __typename id title } }
      userErrors { field message }
    }
  }
`;

const REORDER = `#graphql
  mutation SaleCalendarReorder($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job { id done }
      userErrors { field message }
    }
  }
`;

const JOB = `#graphql
  query SaleCalendarJob($id: ID!) { job(id: $id) { done } }
`;

type CollectionState = {
  id: string;
  title: string;
  sortOrder: string;
  sources: { __typename: string; id: string; title: string | null }[];
};

async function collectionState(admin: Admin, collectionId: string) {
  const data = await gql<{ collection: CollectionState | null }>(admin, COLLECTION_STATE, {
    id: collectionId,
  });
  return data.collection;
}

async function sourceSelections(admin: Admin, sourceId: string) {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const data: {
      node: {
        inclusion: {
          selections: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: { product: { id: string } }[];
          };
        } | null;
      } | null;
    } = await gql(admin, SOURCE_SELECTIONS, { id: sourceId, cursor });
    const selections = data.node?.inclusion?.selections;
    if (!selections) break;
    ids.push(...selections.nodes.map((n) => n.product.id));
    cursor = selections.pageInfo.hasNextPage ? selections.pageInfo.endCursor : null;
  } while (cursor);
  return ids;
}

async function updateCollection(admin: Admin, collection: Record<string, unknown>) {
  const data = await gql<{
    collectionUpdate: {
      collection: { sources: CollectionState["sources"] } | null;
      userErrors: { message: string }[];
    };
  }>(admin, UPDATE_COLLECTION, { collection });
  userErrors(data.collectionUpdate.userErrors);
  return data.collectionUpdate.collection;
}

const selections = (ids: string[]) => ids.map((productId) => ({ productId }));

/** Product ids that should be in the collection now, in display order. */
async function desiredProducts(shop: string, now: Date) {
  const sales = await prisma.sale.findMany({
    where: { shop },
    include: { products: { orderBy: { position: "asc" } } },
  });
  const live = sales
    .filter(
      (s) =>
        saleStatus(s.startsAt?.toISOString() ?? null, s.endsAt?.toISOString() ?? null, now) ===
        "live",
    )
    // "First sale's products, then the next sale's": sheet order.
    .sort((a, b) => a.position - b.position);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const sale of live) {
    for (const p of sale.products) {
      if (!seen.has(p.productId)) {
        seen.add(p.productId);
        ordered.push(p.productId);
      }
    }
  }
  return { ordered, liveSales: live.map((s) => s.name) };
}

async function waitForJob(admin: Admin, jobId: string) {
  for (let i = 0; i < 20; i += 1) {
    const data = await gql<{ job: { done: boolean } | null }>(admin, JOB, { id: jobId });
    if (!data.job || data.job.done) return;
    await sleep(1500);
  }
}

async function reorder(admin: Admin, collection: CollectionState, ordered: string[]) {
  if (!ordered.length) return;
  if (collection.sortOrder !== "MANUAL") {
    await updateCollection(admin, { id: collection.id, sortOrder: "MANUAL" });
  }
  for (let i = 0; i < ordered.length; i += MOVE_BATCH) {
    const moves = ordered
      .slice(i, i + MOVE_BATCH)
      .map((id, j) => ({ id, newPosition: String(i + j) }));
    const data = await gql<{
      collectionReorderProducts: {
        job: { id: string; done: boolean } | null;
        userErrors: { message: string }[];
      };
    }>(admin, REORDER, { id: collection.id, moves });
    userErrors(data.collectionReorderProducts.userErrors);
    const job = data.collectionReorderProducts.job;
    if (job && !job.done) await waitForJob(admin, job.id);
  }
}

const running = new Set<string>();

export interface SyncSummary {
  added: number;
  removed: number;
  live: string[];
  message: string;
}

export async function syncShop(admin: Admin, shop: string, now = new Date()): Promise<SyncSummary> {
  if (running.has(shop)) {
    return { added: 0, removed: 0, live: [], message: "A sync is already running." };
  }
  running.add(shop);
  try {
    const settings = await getSettings(shop);
    if (!settings.collectionId) {
      return { added: 0, removed: 0, live: [], message: "No collection selected." };
    }

    const collection = await collectionState(admin, settings.collectionId);
    if (!collection) {
      const message = "The selected collection no longer exists. Choose a collection again.";
      await prisma.saleSettings.update({
        where: { shop },
        data: { lastSyncAt: now, lastSyncMessage: message, sourceId: null },
      });
      return { added: 0, removed: 0, live: [], message };
    }

    const { ordered, liveSales } = await desiredProducts(shop, now);

    // Our source, if it still exists in this collection.
    let sourceId =
      settings.sourceId && collection.sources.some((s) => s.id === settings.sourceId)
        ? settings.sourceId
        : null;
    const current = sourceId ? await sourceSelections(admin, sourceId) : [];
    const currentSet = new Set(current);
    const desiredSet = new Set(ordered);
    const toAdd = ordered.filter((id) => !currentSet.has(id));
    const toRemove = current.filter((id) => !desiredSet.has(id));

    if (!ordered.length) {
      // No live sale: remove the app's source entirely (only our products go).
      if (sourceId) {
        await updateCollection(admin, { id: collection.id, sourcesToDelete: [sourceId] });
        sourceId = null;
      }
    } else if (!sourceId) {
      const before = new Set(collection.sources.map((s) => s.id));
      const updated = await updateCollection(admin, {
        id: collection.id,
        sourcesToCreate: [
          {
            source: {
              title: APP_SOURCE_TITLE,
              description: "Added and removed automatically by the Sale Calendar page.",
              targetType: "PRODUCTS",
              inclusion: { selections: selections(ordered.slice(0, SELECTION_BATCH)) },
            },
          },
        ],
      });
      const created = updated?.sources.find((s) => !before.has(s.id));
      if (!created) throw new Error("Could not create the app's source in the collection.");
      sourceId = created.id;
      await addRemove(admin, collection.id, sourceId, ordered.slice(SELECTION_BATCH), []);
    } else {
      await addRemove(admin, collection.id, sourceId, toAdd, toRemove);
    }

    const added = toAdd.length;
    const removed = ordered.length ? toRemove.length : current.length;
    const changed = added > 0 || removed > 0;

    let needsReorder = settings.needsReorder || changed;
    let reorderNote = "";
    if (settings.reorder && needsReorder && ordered.length) {
      try {
        await reorder(admin, collection, ordered);
        needsReorder = false;
      } catch (error) {
        // New products can take a moment to appear in the collection; retry next run.
        reorderNote = ` Ordering will retry: ${error instanceof Error ? error.message : error}`;
      }
    } else if (!ordered.length || !settings.reorder) {
      needsReorder = false;
    }

    const message = changed
      ? `Added ${added}, removed ${removed}. Live: ${liveSales.join(", ") || "none"}.${reorderNote}`
      : `No changes. Live: ${liveSales.join(", ") || "none"}.${reorderNote}`;

    await prisma.saleSettings.update({
      where: { shop },
      data: { sourceId, needsReorder, lastSyncAt: now, lastSyncMessage: message },
    });
    if (changed || reorderNote) await log(shop, message);
    return { added, removed, live: liveSales, message };
  } catch (error) {
    const message = `Sync failed: ${error instanceof Error ? error.message : String(error)}`;
    await prisma.saleSettings.update({
      where: { shop },
      data: { lastSyncAt: now, lastSyncMessage: message },
    });
    await log(shop, message);
    throw error;
  } finally {
    running.delete(shop);
  }
}

async function addRemove(
  admin: Admin,
  collectionId: string,
  sourceId: string,
  add: string[],
  remove: string[],
) {
  const update = (a: string[], r: string[]) =>
    updateCollection(admin, {
      id: collectionId,
      sourcesToUpdate: [
        {
          condition: {
            id: sourceId,
            inclusion: { selectionsToAdd: selections(a), selectionsToRemove: selections(r) },
          },
        },
      ],
    });
  for (let i = 0; i < add.length; i += SELECTION_BATCH) {
    await update(add.slice(i, i + SELECTION_BATCH), []);
  }
  for (let i = 0; i < remove.length; i += SELECTION_BATCH) {
    await update([], remove.slice(i, i + SELECTION_BATCH));
  }
}

/**
 * Switching to another collection: take the app's products out of the old
 * one first, so nothing is left behind.
 */
export async function detachCollection(admin: Admin, shop: string) {
  const settings = await getSettings(shop);
  if (settings.collectionId && settings.sourceId) {
    const collection = await collectionState(admin, settings.collectionId);
    if (collection?.sources.some((s) => s.id === settings.sourceId)) {
      await updateCollection(admin, { id: collection.id, sourcesToDelete: [settings.sourceId] });
    }
  }
  await prisma.saleSettings.update({
    where: { shop },
    data: { sourceId: null, needsReorder: false },
  });
}
