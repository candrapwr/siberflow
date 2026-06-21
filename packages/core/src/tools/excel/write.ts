import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
// exceljs ships as CommonJS. Under NodeNext ESM, named imports off a CJS
// module are not statically resolvable at runtime even though the type defs
// allow them at compile time — so import the default and destructure.
import ExcelJS from "exceljs";
import type { Cell, Row, Worksheet } from "exceljs";
import type { Tool } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";
import {
  resolveStyling,
  type ResolvedStyling,
  type StylingConfig,
} from "./styles.js";

const { Workbook } = ExcelJS;

interface Args {
  path: string;
  sheets: Record<string, Record<string, unknown>[]>;
  styling?: StylingConfig;
}

// Excel sheet name constraints.
const MAX_SHEET_NAME_LEN = 31;
const INVALID_SHEET_NAME_CHARS = /[\\/?*[\]:]/g;
const MAX_ROWS_PER_SHEET = 1_000_000; // Excel hard limit ~1,048,576

export const writeExcelTool: Tool = {
  name: "write_excel",
  description:
    "Create or overwrite an Excel (.xlsx) workbook. Each entry in `sheets` becomes a " +
    "tab whose name is the map key; the value is an array of row objects whose keys " +
    "become column headers. By default the output is already styled (header bold on a " +
    "blue background with frozen header row, zebra striping, and auto-fit column widths) " +
    "so you can omit `styling` entirely for a clean result. Use `styling.theme` to pick a " +
    "preset (`professional`, `zebra`, `minimal`, `colorful`) and override individual fields " +
    "as needed. Colors accept names (`blue`, `lightgray`) or hex (`#4472C4`). Number " +
    "formats accept names (`currency`, `date`, `percent`, `integer`, `decimal`) or raw " +
    "Excel format strings. Restricted to the project directory. Overwrites existing files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Destination .xlsx path, absolute or relative to project dir. Overwrites if it exists.",
      },
      sheets: {
        type: "object",
        description:
          "Map of sheet name → array of row objects. Each object's keys define the columns. " +
          "Example: { \"Penjualan\": [ { \"produk\": \"Indomie\", \"qty\": 10 } ], \"Stok\": [ ... ] }",
        additionalProperties: {
          type: "array",
          items: { type: "object" },
        },
      },
      styling: {
        type: "object",
        description:
          "Optional styling. Omit for sensible defaults. Use `theme` for a preset and " +
          "override specific fields.",
        properties: {
          theme: {
            type: "string",
            enum: ["professional", "zebra", "minimal", "colorful"],
            description: "Preset look (default `professional`)",
          },
          header: {
            type: "object",
            description: "Header row styling",
            properties: {
              bold: { type: "boolean" },
              background: { type: "string", description: "Named color or #RRGGBB" },
              color: { type: "string", description: "Header text color: named or #RRGGBB" },
            },
            additionalProperties: false,
          },
          zebraRows: { type: "boolean", description: "Alternate row background for readability" },
          freezeHeader: { type: "boolean", description: "Freeze the header row" },
          autoWidth: { type: "boolean", description: "Auto-fit column widths to content" },
          numberFormats: {
            type: "object",
            description:
              "Map of column name → named format (`currency`, `date`, `percent`, `integer`, `decimal`) " +
              "or raw Excel format string",
            additionalProperties: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    },
    required: ["path", "sheets"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = parseArgs(args);
    const full = await resolveWithin(ctx.projectDir, parsed.path);
    await mkdir(dirname(full), { recursive: true });

    const resolved = resolveStyling(parsed.styling);

    const workbook = new Workbook();
    workbook.creator = "siberflow";
    workbook.created = new Date();
    workbook.modified = new Date();

    const report: { sheet: string; rows: number; columns: string[] }[] = [];

    for (const [sheetName, rows] of Object.entries(parsed.sheets)) {
      const ws = workbook.addWorksheet(sheetName);
      const columns = inferColumns(rows);
      writeSheet(ws, rows, columns, resolved);
      report.push({ sheet: sheetName, rows: rows.length, columns });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    await writeFile(full, Buffer.from(buffer));

    const lines = [
      `Wrote ${report.length} sheet(s) to ${full}`,
      ...report.map(
        (r) =>
          `  • ${r.sheet}: ${r.rows} rows × ${r.columns.length} cols (${r.columns.join(", ") || "no columns"})`,
      ),
      resolved.appliedDefault
        ? "(default styling applied: professional theme — styled header, zebra rows, frozen header, auto width)"
        : `(styling: theme=${parsed.styling?.theme ?? "professional"})`,
    ];
    return lines.join("\n");
  },
};

/** Validate the tool args and normalize the sheets map. */
function parseArgs(args: unknown): Args {
  if (!args || typeof args !== "object") {
    throw new Error("arguments must be an object");
  }
  const input = args as Record<string, unknown>;

  const path = input.path;
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("`path` is required and must be a non-empty string");
  }

  const sheetsInput = input.sheets;
  if (!sheetsInput || typeof sheetsInput !== "object" || Array.isArray(sheetsInput)) {
    throw new Error("`sheets` is required and must be an object mapping sheet name → array of rows");
  }
  const sheetsRaw = sheetsInput as Record<string, unknown>;
  if (Object.keys(sheetsRaw).length === 0) {
    throw new Error("`sheets` must contain at least one sheet");
  }

  const sheets: Record<string, Record<string, unknown>[]> = {};
  const seenNames = new Set<string>();
  for (const [rawName, rowsRaw] of Object.entries(sheetsRaw)) {
    const name = validateSheetName(rawName, seenNames);
    seenNames.add(name.toLowerCase());

    if (!Array.isArray(rowsRaw)) {
      throw new Error(`Sheet "${name}": rows must be an array of objects`);
    }
    if (rowsRaw.length > MAX_ROWS_PER_SHEET) {
      throw new Error(
        `Sheet "${name}": ${rowsRaw.length} rows exceeds the ${MAX_ROWS_PER_SHEET} row limit`,
      );
    }
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < rowsRaw.length; i++) {
      const r = rowsRaw[i];
      if (r === null || typeof r !== "object" || Array.isArray(r)) {
        throw new Error(`Sheet "${name}": row ${i + 1} must be an object, got ${typeof r}`);
      }
      rows.push(r as Record<string, unknown>);
    }
    sheets[name] = rows;
  }

  let styling: StylingConfig | undefined;
  if (input.styling !== undefined) {
    if (input.styling === null || typeof input.styling !== "object" || Array.isArray(input.styling)) {
      throw new Error("`styling` must be an object when provided");
    }
    styling = input.styling as StylingConfig;
  }

  return { path, sheets, ...(styling ? { styling } : {}) };
}

/** Enforce Excel sheet name rules: length, forbidden chars, uniqueness. */
function validateSheetName(raw: string, seen: Set<string>): string {
  const name = raw.trim();
  if (name.length === 0) throw new Error("Sheet names must be non-empty");
  if (name.length > MAX_SHEET_NAME_LEN) {
    throw new Error(`Sheet name "${name}" exceeds ${MAX_SHEET_NAME_LEN} characters`);
  }
  if (INVALID_SHEET_NAME_CHARS.test(name)) {
    throw new Error(`Sheet name "${name}" contains forbidden characters \\ / ? * [ ] :`);
  }
  if (seen.has(name.toLowerCase())) {
    throw new Error(`Duplicate sheet name (case-insensitive): "${name}"`);
  }
  return name;
}

/**
 * Determine the column order for a sheet by preserving the key order of the
 * first row, then appending any keys that appear only in later rows.
 */
function inferColumns(rows: Record<string, unknown>[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }
  return ordered;
}

/**
 * Write header + rows into the worksheet and apply the resolved styling:
 * styled header row, zebra striping, number formats per column, frozen panes,
 * and auto-width.
 */
function writeSheet(
  ws: Worksheet,
  rows: Record<string, unknown>[],
  columns: string[],
  styling: ResolvedStyling,
): void {
  // Header row.
  const headerRow = ws.addRow(columns);
  styleHeaderRow(headerRow, styling);

  // Data rows.
  for (const row of rows) {
    const values = columns.map((c) => coerceValue(row[c]));
    const added = ws.addRow(values);
    const dataRowNumber = added.number;
    // Zebra background applied via row cell iteration.
    if (styling.zebraRows && dataRowNumber % 2 === 0) {
      for (const cell of iterateCells(added, columns.length)) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: styling.zebraColor },
        };
      }
    }
  }

  // Per-column number formats (skip the header cell).
  if (Object.keys(styling.numberFormats).length > 0) {
    applyNumberFormats(ws, columns, styling.numberFormats);
  }

  // Freeze the header row + the leftmost columns.
  if (styling.freezeHeader) {
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];
  }

  // Auto-fit column widths based on the longest cell (capped for sanity).
  if (styling.autoWidth) {
    autoFitColumns(ws, columns);
  }
}

/** Apply the header styling (bold + fill + text color) to every header cell. */
function styleHeaderRow(row: Row, styling: ResolvedStyling): void {
  row.eachCell((cell) => {
    cell.font = {
      bold: styling.header.bold,
      color: { argb: styling.header.color },
    };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: styling.header.background },
    };
    cell.alignment = { horizontal: "left", vertical: "middle" };
  });
}

/** Apply a number format to each named column's data cells (header excluded). */
function applyNumberFormats(
  ws: Worksheet,
  columns: string[],
  formats: Record<string, string>,
): void {
  columns.forEach((colName, idx) => {
    const fmt = formats[colName];
    if (!fmt) return;
    const colIndex = idx + 1; // exceljs columns are 1-based
    const column = ws.getColumn(colIndex);
    column.numFmt = fmt;
  });
}

/** Iterate non-empty cells in a row, up to `count` columns. */
function* iterateCells(row: Row, count: number): Generator<Cell> {
  for (let i = 1; i <= count; i++) {
    const cell = row.getCell(i);
    if (cell) yield cell;
  }
}

/**
 * Set each column's width to fit its content. Width is measured in characters
 * (exceljs convention), capped at 60 so a single long string doesn't blow up
 * the layout. The header is included in the measurement.
 */
function autoFitColumns(ws: Worksheet, columns: string[]): void {
  columns.forEach((colName, idx) => {
    const colIndex = idx + 1;
    const column = ws.getColumn(colIndex);
    let maxLen = colName.length;
    ws.eachRow((row) => {
      const cell = row.getCell(colIndex);
      const text = cellText(cell);
      if (text.length > maxLen) maxLen = text.length;
    });
    column.width = Math.min(Math.max(maxLen + 2, 8), 60);
  });
}

/** Read a cell's display text for width measurement. */
function cellText(cell: Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v !== null && "richText" in v) {
    const runs = (v as { richText: { text: string }[] }).richText;
    return runs.map((r) => r.text).join("");
  }
  return String(v);
}

/**
 * Coerce a JS value into a cell value exceljs understands.
 *
 * Tool args arrive as JSON (the registry JSON.parses the model's call), so any
 * Date the model emitted has already been serialized to an ISO string by
 * `JSON.stringify`. Detect ISO date strings here and convert them back to real
 * Date objects so exceljs stores them as proper date cells (which then honor
 * `date`/`datetime` number formats and read back as Dates, not strings).
 *
 * Strict ISO 8601 only — `yyyy-mm-dd` or `yyyy-mm-ddThh:mm:ss(.sss)?Z?` — so
 * free-text strings like "2025-Q1" or "January" are never misinterpreted.
 */
function coerceValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const asDate = parseIsoDate(value);
    if (asDate) return asDate;
  }
  return value;
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Return a Date if `s` is a strict ISO date/datetime string, else null.
 *
 * `new Date("2025-01-01")` (date-only) is parsed as UTC midnight, which then
 * shifts when exceljs writes it in the local timezone — a `2025-01-01` cell
 * ends up read back as `2025-01-01 07:00:00` in UTC+7. To keep a date-only
 * value landing on that calendar day, parse it as local midnight instead.
 * Full datetimes carry their own offset (or Z) and keep `new Date()` semantics.
 */
function parseIsoDate(s: string): Date | null {
  const str = s.trim();
  if (ISO_DATE_ONLY.test(str)) {
    const [y, m, d] = str.split("-").map((n) => Number.parseInt(n, 10));
    const date = new Date(y!, m! - 1, d!);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (ISO_DATETIME.test(str)) {
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
