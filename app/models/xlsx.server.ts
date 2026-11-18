import { inflateRawSync } from "node:zlib";

// Minimal, dependency-free .xlsx reader: enough to read cell values and
// hyperlinks (including links to other tabs) from the Sale Calendar sheet.

export interface SheetCell {
  value: string;
  /** External URL, or the internal target like "'Garmin '!A1". */
  link?: string;
}

export interface Workbook {
  /** Tab names in workbook order. */
  sheetNames: string[];
  /** Tab name -> cell reference ("B2") -> cell. */
  sheets: Map<string, Map<string, SheetCell>>;
}

function unzip(buffer: Buffer) {
  const files = new Map<string, Buffer>();
  // End of central directory record (scan back over an optional comment).
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file.");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt .xlsx file.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    files.set(name, method === 0 ? data : inflateRawSync(data));

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const textOf = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([^]*?)<\/t>/g)].map((m) => m[1]).join("");

const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

export function readWorkbook(buffer: Buffer): Workbook {
  const files = unzip(buffer);
  const text = (path: string) => files.get(path)?.toString("utf8");

  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([^]*?)<\/si>/g)].map(
    (m) => decode(textOf(m[1])),
  );

  const workbookXml = text("xl/workbook.xml");
  const relsXml = text("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) throw new Error("Not a valid .xlsx file.");

  const relTargets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) relTargets.set(id, target);
  }

  const sheetNames: string[] = [];
  const sheets = new Map<string, Map<string, SheetCell>>();

  for (const m of workbookXml.matchAll(/<sheet\s[^>]*>/g)) {
    const name = decode(attr(m[0], "name") ?? "");
    const target = relTargets.get(attr(m[0], "r:id") ?? "");
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const xml = text(path);
    if (!xml) continue;

    const cells = new Map<string, SheetCell>();
    for (const c of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([^]*?)<\/c>)/g)) {
      const ref = attr(c[1], "r");
      const body = c[2] ?? "";
      if (!ref || !body) continue;
      const type = attr(c[1], "t");
      const raw = body.match(/<v>([^]*?)<\/v>/)?.[1];
      let value: string | undefined;
      if (type === "s" && raw !== undefined) value = shared[Number(raw)];
      else if (type === "inlineStr") value = decode(textOf(body));
      else if (raw !== undefined) value = decode(raw);
      if (value !== undefined) cells.set(ref, { value });
    }

    const sheetRels = new Map<string, string>();
    const relPath = path.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels");
    for (const r of (text(relPath) ?? "").matchAll(/<Relationship\s[^>]*>/g)) {
      const id = attr(r[0], "Id");
      const target = attr(r[0], "Target");
      if (id && target) sheetRels.set(id, decode(target));
    }
    for (const h of xml.matchAll(/<hyperlink\s[^>]*>/g)) {
      const ref = attr(h[0], "ref");
      if (!ref) continue;
      const id = attr(h[0], "r:id");
      const location = attr(h[0], "location");
      const link = id ? sheetRels.get(id) : location ? decode(location) : undefined;
      if (!link) continue;
      const cell = cells.get(ref) ?? { value: "" };
      cell.link = link;
      cells.set(ref, cell);
    }

    sheetNames.push(name);
    sheets.set(name, cells);
  }

  return { sheetNames, sheets };
}
