import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
// exceljs ships as CommonJS. Under NodeNext ESM, named imports off a CJS
// module are not statically resolvable at runtime even though the type defs
// allow them at compile time — so import the default and destructure.
import ExcelJS from "exceljs";
import type { CellValue, Worksheet } from "exceljs";
import type { Tool, ToolContext } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";

const { Workbook } = ExcelJS;

interface Args {
  path: string;
  sheet?: string;
  maxRows?: number;
  format?: "table" | "json";
}

const DEFAULT_MAX_ROWS = 500;
const MAX_OUTPUT_CHARS = 200_000;

export const readExcelTool: Tool = {
  name: "read_excel",
  description:
    "Read an Excel (.xlsx) workbook from disk and return its contents as text. " +
    "Supports multiple sheets/tabs. By default reads ALL sheets, each prefixed with a " +
    "`=== Sheet: <name> (<rows> rows) ===` header. Pass `sheet` to read one specific tab " +
    "(if the name is wrong, the available sheet names are returned). " +
    "Output format defaults to markdown `table`; use `format: \"json\"` for JSON rows " +
    "(better when you need exact numeric values). Data types are preserved: numbers stay " +
    "numbers, dates become ISO `yyyy-mm-dd` strings, formulas return their computed result. " +
    "Restricted to files inside the project directory.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Excel file path (.xlsx), absolute or relative to project dir",
      },
      sheet: {
        type: "string",
        description: "Optional: read only this sheet/tab by name. Omit to read all sheets.",
      },
      maxRows: {
        type: "integer",
        description: "Max rows to read per sheet (default 500)",
        minimum: 1,
      },
      format: {
        type: "string",
        enum: ["table", "json"],
        description: "Output format. `table` = markdown table (default), `json` = array of row objects per sheet",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = parseArgs(args);
    const full = await resolveExcelPath(ctx, parsed.path);
    const data = await readFile(full);

    const workbook = new Workbook();
    // Known type-only mismatch: exceljs ships an older @types/node Buffer
    // declaration whose `[Symbol.toStringTag]` is 'ArrayBuffer', while
    // @types/node v22+ uses 'Uint8Array'. They are the same runtime object.
    // No cast bridges the structural check, so suppress at the call site.
    // (skipLibCheck hides this inside exceljs itself, but not at our boundary.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(data as any);

    const available = workbook.worksheets.map((ws) => ws.name);

    // Choose which sheets to read.
    let sheets: Worksheet[];
    if (parsed.sheet) {
      const target = workbook.worksheets.find(
        (ws) => ws.name.toLowerCase() === parsed.sheet!.toLowerCase(),
      );
      if (!target) {
        throw new Error(
          `Sheet "${parsed.sheet}" not found. Available sheets: ${available.join(", ")}`,
        );
      }
      sheets = [target];
    } else {
      sheets = workbook.worksheets;
    }

    const format = parsed.format ?? "table";
    const parts: string[] = [];

    for (const ws of sheets) {
      const part = format === "json"
        ? sheetToJson(ws, parsed.maxRows)
        : sheetToTable(ws, parsed.maxRows);
      if (part.rowsRead === 0) continue; // skip empty sheets
      if (format === "json") {
        parts.push(
          `=== Sheet: ${ws.name} (${part.rowsRead} rows, ${part.truncated ? "truncated" : "full"}) ===\n${part.body}`,
        );
      } else {
        parts.push(
          `=== Sheet: ${ws.name} (${part.rowsRead} rows${part.truncated ? ", truncated" : ""}) ===\n${part.body}`,
        );
      }
    }

    let out: string;
    if (parts.length === 0) {
      out = parsed.sheet
        ? `Sheet "${parsed.sheet}" is empty.`
        : `Workbook has ${available.length} sheet(s) and all are empty.`;
    } else {
      out = parts.join("\n\n");
    }

    if (out.length > MAX_OUTPUT_CHARS) {
      const trimmed = out.slice(0, MAX_OUTPUT_CHARS);
      out =
        trimmed +
        `\n\n... [truncated ${out.length - MAX_OUTPUT_CHARS} chars — re-call with a specific \`sheet\` or lower \`maxRows\` to read more]`;
    }
    return out;
  },
};

/**
 * Resolve a read path against either the per-session upload dir (tmp, where
 * uploaded Excels land) or the project sandbox.
 *
 * Upload-dir access is granted ONLY for absolute paths that land inside it —
 * relative paths are always resolved against the project sandbox (so a stray
 * `internal.xlsx` doesn't accidentally hit a same-named file in the upload
 * dir). Anything that escapes both is rejected by `resolveWithin`, matching
 * the pre-upload behavior. Only `read_excel` uses this; other file tools
 * never see `uploadDir`.
 */
async function resolveExcelPath(ctx: ToolContext, p: string): Promise<string> {
  if (ctx.uploadDir && isAbsolute(p)) {
    try {
      return await resolveWithin(ctx.uploadDir, p);
    } catch {
      // Absolute path not inside the upload dir — fall through to the project
      // sandbox check below (which may reject it if it's also outside there).
    }
  }
  return resolveWithin(ctx.projectDir, p);
}

function parseArgs(args: unknown): Args {
  if (!args || typeof args !== "object") {
    throw new Error("arguments must be an object");
  }
  const input = args as Record<string, unknown>;

  const path = input.path;
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("`path` is required and must be a non-empty string");
  }

  const result: Args = { path };

  if (input.sheet !== undefined) {
    if (typeof input.sheet !== "string" || input.sheet.trim() === "") {
      throw new Error("`sheet` must be a non-empty string when provided");
    }
    result.sheet = input.sheet;
  }

  if (input.maxRows !== undefined) {
    const n = input.maxRows;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
      throw new Error("`maxRows` must be a positive integer");
    }
    result.maxRows = Math.floor(n);
  }

  if (input.format !== undefined) {
    if (input.format !== "table" && input.format !== "json") {
      throw new Error('`format` must be "table" or "json"');
    }
    result.format = input.format;
  }

  return result;
}

interface SheetOutput {
  body: string;
  rowsRead: number;
  truncated: boolean;
}

/**
 * Render a sheet as a markdown table. The first non-empty row is treated as the
 * header. Cell text is escaped (pipes and newlines) so the table stays valid.
 */
function sheetToTable(ws: Worksheet, maxRows?: number): SheetOutput {
  const limit = maxRows ?? DEFAULT_MAX_ROWS;
  const rows: string[][] = [];
  let rowCount = 0;
  let truncated = false;

  ws.eachRow({ includeEmpty: false }, (row) => {
    if (rowCount >= limit) {
      truncated = true;
      return;
    }
    const values = (row.values as (CellValue | undefined)[]).slice(1); // index 0 is a gap in exceljs
    const textRow = values.map(cellToText);
    rows.push(textRow);
    rowCount++;
  });

  if (rows.length === 0) {
    return { body: "", rowsRead: 0, truncated: false };
  }

  const header = rows[0]!;
  const dataRows = rows.slice(1);
  const width = header.length;

  const lines: string[] = [];
  lines.push(`| ${header.map(escapeCell).join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const r of dataRows) {
    // Pad/trim each row to header width so the table aligns.
    const padded = r.slice(0, width);
    while (padded.length < width) padded.push("");
    lines.push(`| ${padded.map(escapeCell).join(" | ")} |`);
  }

  return { body: lines.join("\n"), rowsRead: rows.length, truncated };
}

/**
 * Render a sheet as a JSON array of row objects keyed by the header row.
 * Numeric precision is preserved (numbers emitted as JSON numbers).
 */
function sheetToJson(ws: Worksheet, maxRows?: number): SheetOutput {
  const limit = maxRows ?? DEFAULT_MAX_ROWS;
  let header: string[] | null = null;
  const objects: Record<string, unknown>[] = [];
  let dataRows = 0;
  let truncated = false;

  ws.eachRow({ includeEmpty: false }, (row) => {
    if (header === null) {
      const values = (row.values as (CellValue | undefined)[]).slice(1);
      header = values.map((v) => cellToText(v) || "");
      return;
    }
    if (dataRows >= limit - 1) {
      // Reserve 1 for the header consumed above.
      truncated = true;
      return;
    }
    const values = (row.values as (CellValue | undefined)[]).slice(1);
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < (header as string[]).length; i++) {
      const key = (header as string[])[i]!;
      if (key === "") continue; // skip unnamed columns
      obj[key] = cellToJson(values[i]);
    }
    objects.push(obj);
    dataRows++;
  });

  if (header === null) {
    return { body: "", rowsRead: 0, truncated: false };
  }

  return {
    body: JSON.stringify(objects, null, 2),
    rowsRead: objects.length,
    truncated,
  };
}

/**
 * Convert a cell value to display text for the table format.
 * - Dates → `yyyy-mm-dd` (or `yyyy-mm-dd hh:mm:ss` if a time component exists).
 * - Numbers/strings → String().
 * - Formula cells → the computed result, not the formula text.
 * - Merged non-master cells → empty (the master cell carries the value).
 * - null/undefined → "".
 */
function cellToText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";

  // Formula object: { formula, result }
  if (typeof value === "object" && value !== null && "formula" in value) {
    const result = (value as { result?: CellValue }).result;
    return cellToText(result);
  }

  // Rich text object: concatenate runs.
  if (typeof value === "object" && value !== null && "richText" in value) {
    const runs = (value as { richText: { text: string }[] }).richText;
    return runs.map((r) => r.text).join("");
  }

  // Hyperlink object: { text, hyperlink }
  if (typeof value === "object" && value !== null && "hyperlink" in value && "text" in value) {
    return String((value as { text: CellValue }).text);
  }

  if (value instanceof Date) return formatDate(value);

  // CellErrorValue: { error: '#N/A' }
  if (typeof value === "object" && value !== null && "error" in value) {
    return String((value as { error: string }).error);
  }

  return String(value);
}

/**
 * Convert a cell value to a JSON-native value (preserves numeric precision).
 * Strings stay strings, numbers stay numbers, dates become ISO strings,
 * formulas resolve to their result, errors become an { error } marker.
 */
function cellToJson(value: CellValue | undefined): unknown {
  if (value === null || value === undefined) return null;

  if (typeof value === "object" && value !== null && "formula" in value) {
    return cellToJson((value as { result?: CellValue }).result);
  }
  if (typeof value === "object" && value !== null && "richText" in value) {
    const runs = (value as { richText: { text: string }[] }).richText;
    return runs.map((r) => r.text).join("");
  }
  if (typeof value === "object" && value !== null && "hyperlink" in value && "text" in value) {
    return String((value as { text: CellValue }).text);
  }
  if (value instanceof Date) return formatDate(value);
  if (typeof value === "object" && value !== null && "error" in value) {
    return { error: String((value as { error: string }).error) };
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

/** Format a Date as `yyyy-mm-dd` (plus time if non-midnight). */
function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hasTime =
    d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
  if (!hasTime) return `${yyyy}-${mm}-${dd}`;
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/** Escape pipe and newline so a cell doesn't break the markdown table. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
