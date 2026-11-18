// Shared (client + server) helpers for the Sale Calendar: date parsing in the
// store's time zone, sale status, and matching sheet names to store products.

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthIndex(word: string) {
  const w = word.toLowerCase();
  const i = MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
  return i < 0 ? null : i + 1;
}

/**
 * Parses the date texts used in the sheet, e.g.
 * "13 November 2026 at 11:30 AM", "November 19, 2026 at 11:30 AM.",
 * "26 November 2026 at 11:30", plus Excel date serial numbers.
 */
export function parseSheetDate(input: string | undefined | null): WallClock | null {
  const text = String(input ?? "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  if (!text) return null;

  // Excel serial date (days since 1899-12-30, fraction = time of day).
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial < 20000 || serial > 80000) return null;
    const ms = Math.round((serial - 25569) * 86400000);
    const d = new Date(ms);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }

  let day: number | null = null;
  let month: number | null = null;
  let year: number | null = null;

  // "November 19, 2026" or "Nov 19 2026"
  let m = text.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) {
    month = monthIndex(m[1]);
    day = Number(m[2]);
    year = Number(m[3]);
  } else {
    // "13 November 2026"
    m = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
    if (m) {
      day = Number(m[1]);
      month = monthIndex(m[2]);
      year = Number(m[3]);
    } else {
      // "2026-11-19" or "2026-11-19T11:30"
      m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) {
        year = Number(m[1]);
        month = Number(m[2]);
        day = Number(m[3]);
      }
    }
  }
  if (!day || !month || !year || day > 31 || month > 12) return null;

  let hour = 0;
  let minute = 0;
  const t = text.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?/);
  if (t) {
    hour = Number(t[1]);
    minute = Number(t[2]);
    const meridiem = t[3]?.toLowerCase().replace(/\./g, "");
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
  }
  return { year, month, day, hour, minute };
}

/** Wall-clock time of `date` in `timeZone`. */
export function toWallClock(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

/** Converts a wall-clock time in `timeZone` to an absolute Date. */
export function zonedToUtc(wall: WallClock, timeZone: string): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const offsetAt = (ms: number) => {
    const w = toWallClock(new Date(ms), timeZone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - ms;
  };
  let utc = asUtc - offsetAt(asUtc);
  utc = asUtc - offsetAt(utc);
  return new Date(utc);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Value for an <input type="datetime-local"> in the store time zone. */
export function toInputValue(iso: string | null, timeZone: string) {
  if (!iso) return "";
  const w = toWallClock(new Date(iso), timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

export function formatInZone(iso: string | null, timeZone: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export type SaleStatus = "upcoming" | "live" | "ended" | "invalid";

export function dateProblem(startsAt: string | null, endsAt: string | null) {
  if (!startsAt && !endsAt) return "Start and end date missing";
  if (!startsAt) return "Start date missing";
  if (!endsAt) return "End date missing";
  if (new Date(endsAt) <= new Date(startsAt)) return "End date is before start date";
  return null;
}

export function saleStatus(
  startsAt: string | null,
  endsAt: string | null,
  now = new Date(),
): SaleStatus {
  if (dateProblem(startsAt, endsAt)) return "invalid";
  if (now < new Date(startsAt!)) return "upcoming";
  if (now < new Date(endsAt!)) return "live";
  return "ended";
}

// ---- Name matching ----

/** One variant of the store catalog: [productId, productTitle, variantTitle]. */
export type CatalogRow = [string, string, string];

export const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[“”″]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/'(?=\d)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+-\s+/g, " - ")
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)/g, ")")
    .trim();

export interface CatalogIndex {
  byName: Map<string, Set<string>>;
  titles: Map<string, string>;
  numericIds: Map<string, string>;
}

/** Name keys: "Product", "Product - Variant", "Product (Variant)", "Product Variant". */
export function buildCatalogIndex(rows: CatalogRow[]): CatalogIndex {
  const byName = new Map<string, Set<string>>();
  const titles = new Map<string, string>();
  const numericIds = new Map<string, string>();
  const add = (key: string, id: string) => {
    const k = normalizeName(key);
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k)!.add(id);
  };
  for (const [id, title, variant] of rows) {
    titles.set(id, title);
    numericIds.set(id.split("/").pop()!, id);
    add(title, id);
    if (variant && variant !== "Default Title") {
      add(`${title} - ${variant}`, id);
      add(`${title} (${variant})`, id);
      add(`${title} ${variant}`, id);
    }
  }
  return { byName, titles, numericIds };
}

/** Returns the matching product id, or null. A product ID from the sheet wins. */
export function matchProduct(
  index: CatalogIndex,
  name: string,
  productId?: string,
): string | null {
  const numeric = productId?.trim().replace(/\.0$/, "").split("/").pop();
  if (numeric && /^\d+$/.test(numeric)) {
    const id = index.numericIds.get(numeric);
    if (id) return id;
  }
  const hits = index.byName.get(normalizeName(name));
  return hits && hits.size ? [...hits][0] : null;
}
