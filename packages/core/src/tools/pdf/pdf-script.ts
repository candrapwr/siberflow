import vm from "node:vm";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/**
 * Resolve a base URL for createRequire that works in both ESM and CJS contexts.
 * In ESM (CLI/desktop main) `import.meta.url` is available. In a CJS bundle
 * (VSCode extension), `import.meta.url` is empty/undefined and esbuild warns
 * about it — fall back to the CJS filename via a require-of-__filename shim so
 * createRequire still resolves pdfjs-dist relative to this module.
 */
function requireBaseUrl(): string {
  try {
    if (typeof import.meta !== "undefined" && (import.meta as { url?: string }).url) {
      return (import.meta as { url: string }).url;
    }
  } catch {
    // import.meta may be syntactically invalid in some CJS contexts.
  }
  // CJS fallback: __filename is defined in CommonJS bundles.
  const filename = (globalThis as { __filename?: string }).__filename;
  return pathToFileURL(filename ?? process.cwd() + "/__placeholder__.js").href;
}
// `pdf-lib` ships as CommonJS with a CJS entry — default export works.
import { PDFDocument, StandardFonts, rgb, degrees, PageSizes } from "pdf-lib";
import type { PDFFont } from "pdf-lib";
import type { Tool, ToolContext } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";

interface Args {
  /** Where the PDF is read from (read mode) AND/OR written back to. */
  path?: string;
  /** Optional explicit destination path (overrides `path` for the write). */
  saveAs?: string;
  /** The JS function expression. Required. */
  script: string;
  /** Read-only mode: extract text via pdfjs-dist, don't write. */
  readOnly?: boolean;
}

/** Max wall-clock time for a script, in ms. Prevents runaway loops. */
const SCRIPT_TIMEOUT_MS = 5000;
/** Cap on the JSON-stringified return value sent back to the model. */
const MAX_RETURN_CHARS = 200_000;

export const pdfScriptTool: Tool = {
  name: "pdf_script",
  description:
    "Create or read a PDF document by running a JavaScript function you supply, with full " +
    "access to the `pdf-lib` API (create mode) or the extracted text content of an existing " +
    "PDF (read mode). This is the single tool for PDF work.\n\n" +
    "MODES:\n" +
    "• Create a new PDF: pass `saveAs` (or `path`) + a script that builds the document via the " +
    "`pdf-lib` API. Signature: `(pdf, P) => { ... }` where `pdf` is a fresh empty `PDFDocument` " +
    "and `P` is the `pdf-lib` module (giving you `PDFDocument`, `StandardFonts`, `rgb`, `degrees`, " +
    "`PageSizes`, etc.). Add pages via `pdf.addPage([width, height])`, then draw text, shapes, " +
    "embed images, etc. The host serializes `pdf` to a PDF buffer via `pdf.save()` and writes it " +
    "to `path`/`saveAs` after the script runs — you never touch the filesystem.\n" +
    "• Read an existing PDF: pass `path` + `readOnly: true`. The host loads the PDF via pdfjs-dist " +
    "(Mozilla PDF.js) and extracts text from EVERY page, then passes that text to your script. " +
    "Signature: `(text) => { ... return data }`. The `text` is a string with pages separated by " +
    "`\\f` (form feed) — split on it to get per-page text. Extract whatever you need and RETURN " +
    "it; the return value is serialized to JSON and sent back to you as the tool result.\n\n" +
    "CREATING — common patterns:\n" +
    "• Page + text: `const page = pdf.addPage([595, 842]); const font = await pdf.embedFont(P.StandardFonts.Helvetica); page.drawText('Title', { x: 50, y: 800, size: 24, font, color: P.rgb(0,0,0) })` " +
    "(A4 = [595, 842] in points; use `P.PageSizes.A4`)\n" +
    "• Note: `embedFont` is async — you CANNOT call it inside the sandbox (the sandbox is " +
    "synchronous). So you must build pages WITHOUT custom fonts, OR ask the host to embed a " +
    "standard font for you. The host pre-embeds Helvetica and passes it as `font` (3rd arg): " +
    "`(pdf, P, font) => { const page = pdf.addPage(P.PageSizes.A4); page.drawText('Hi', { x:50, y:800, size:24, font }); }`\n" +
    "• Shapes: `page.drawRectangle({ x, y, width, height, color: P.rgb(1,0,0) })`, `page.drawLine({ start:{x,y}, end:{x,y}, thickness:2 })`\n" +
    "• Image: `const img = await pdf.embedPng(bytes)` — but embed is async, so images must be " +
    "pre-embedded. If you need images, read the bytes OUTSIDE this tool (via read_file) and " +
    "note that async embed cannot run in the sandbox. For now, create text/shape-only PDFs.\n" +
    "• TEXT ALIGNMENT / WIDTH (IMPORTANT): to right/center align text, do NOT guess width with " +
    "`text.length * size * 0.5` — that is unreliable AND produces NaN if any operand is undefined. " +
    "Use the EXACT api: `font.widthOfTextAtSize(text, size)` returns the real rendered width in " +
    "points. Example right-align: `const w = font.widthOfTextAtSize(text, size); page.drawText(text, { x: rightEdge - w - 4, y, size, font });`\n" +
    "• AVOID NaN: every draw option (x, y, width, height, size, color.red/.green/.blue) must be a " +
    "finite number. If a row/cell is missing, guard with `(row[c] ?? '')` and a default size — " +
    "do NOT let `undefined` flow into arithmetic. A NaN throws a hard error.\n" +
    "• All coordinate math must use real numbers: validate inputs, default missing array cells, " +
    "and never multiply by `undefined`.\n" +
    "• LAYOUT (avoid content cut off on the right): before finalizing, verify that the sum of all " +
    "column/element widths PLUS the left margin fits within the page width. The tool will WARN you " +
    "if any drawn text/shape extends past the right page edge. For wide tables use A4 Landscape " +
    "(`pdf.addPage([842, 595])`) and allocate each column a width >= its widest value (check with " +
    "`font.widthOfTextAtSize(text, size)`). A4 portrait = 595pt wide; A4 landscape = 842pt wide.\n\n" +
    "READING — the text you receive is pdfjs-dist's extraction. Note: scanned PDFs (images of " +
    "text, no embedded text layer) will return EMPTY text — pdfjs-dist cannot OCR. Only PDFs with " +
    "a real text layer (generated digitally) extract properly.\n\n" +
    "FONT LIMITATION: the pre-embedded font is Helvetica (WinAnsi encoding). It supports Latin/" +
    "Western European text only. Emoji (e.g. ❤😀), CJK characters, and other non-Latin scripts " +
    "cannot be rendered and will be auto-replaced with '?'. Use ASCII-safe text only.\n\n" +
    "The script MUST be synchronous. The host performs all async I/O (loading, pdfjs text " +
    "extraction, pdf-lib serialization, writing) outside the sandbox. The sandbox blocks " +
    "`require`, `process`, `fs`, network, `eval`, `Function`, and `Promise`; execution is capped " +
    "at 5 seconds. On error, the message is returned so you can fix and retry.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "PDF to read (when readOnly:true) OR the destination to write (create mode). In read " +
          "mode the file must exist. Absolute or relative to project dir.",
      },
      saveAs: {
        type: "string",
        description:
          "Optional explicit destination path for create mode (overrides `path` for the write). " +
          "Must be inside the project sandbox.",
      },
      script: {
        type: "string",
        description:
          "A synchronous JavaScript function expression.\n" +
          "Create mode: `(pdf, P, font) => { ... }` — `pdf` is a fresh PDFDocument, `P` is the " +
          "pdf-lib module, `font` is a pre-embedded Helvetica font (so you can call drawText " +
          "without async embedFont).\n" +
          "Read mode: `(text) => { ... return data }` — `text` is the full text with `\\f` " +
          "between pages.\n" +
          "Examples —\n" +
          "Create: \"(pdf, P, font) => { const page = pdf.addPage(P.PageSizes.A4); page.drawText('Report Title', { x: 50, y: 800, size: 28, font, color: P.rgb(0,0,0) }); page.drawRectangle({ x: 50, y: 770, width: 200, height: 3, color: P.rgb(0.8,0,0) }); }\"\n" +
          "Read: \"(text) => { const pages = text.split('\\\\f'); return { pageCount: pages.length, firstPage: pages[0].slice(0, 500), wordCount: text.split(/\\\\s+/).length }; }\"",
      },
      readOnly: {
        type: "boolean",
        description:
          "If true: read mode. The PDF at `path` is loaded and its text extracted via pdfjs-dist, " +
          "passed to the script; nothing is written to disk. Default false (create mode).",
      },
    },
    required: ["script"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = parseArgs(args);

    // ----- READ MODE -------------------------------------------------------
    // Host loads the PDF and extracts text via pdfjs-dist (async, can't run in
    // the sync sandbox). The resulting text string is handed to the script.
    if (parsed.readOnly === true) {
      if (!parsed.path) {
        throw new Error("`path` is required in read mode (the PDF to read).");
      }
      const loadPath = await resolveSourcePath(ctx, parsed.path);
      const buffer = await readFile(loadPath);
      const text = await extractPdfText(buffer);

      const returnValue = runReadScript(text, parsed.script);
      return summarize({ loadedFrom: loadPath, wroteTo: undefined, readOnly: true, returnValue });
    }

    // ----- CREATE MODE -----------------------------------------------------
    const target = parsed.saveAs ?? parsed.path;
    if (!target) {
      throw new Error(
        "`path` or `saveAs` is required in create mode (the destination PDF). Pass readOnly:true " +
          "for a read-only script.",
      );
    }
    const destPath = await resolveWithin(ctx.projectDir, target);

    // Build a fresh PDFDocument and pre-embed a standard font so the script
    // can call drawText synchronously (embedFont is async — blocked in sandbox).
    const pdf = await PDFDocument.create();
    pdf.setCreator("siberflow");
    pdf.setTitle("Siberflow PDF");
    pdf.setProducer("pdf-lib + siberflow");
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    // Wrap the font so drawText won't throw on characters the WinAnsi-encoded
    // standard font can't represent (emoji, CJK, etc.). Such chars are replaced
    // with '?' and collected so we can warn the model at the end.
    const { patchedFont, droppedChars } = patchFontEncoding(font);

    // Run the user script against the fresh Document + pdf-lib module + font.
    // Wrap pdf so cross-realm (sandbox) arrays/objects passed to addPage and
    // the draw methods are rebuilt in the host realm before pdf-lib's
    // instanceof-based validation sees them. Without this, `pdf.addPage([595,842])`
    // throws a misleading "page was NaN" error (cross-realm instanceof fails).
    // The wrapper also tracks right-edge overflow so we can warn the AI if its
    // layout spills past the page width (content "cut off on the right").
    const { pdf: wrappedPdf, overflow } = wrapPdf(pdf);
    const returnValue = runCreateScript(wrappedPdf, patchedFont, parsed.script);

    // Serialize to PDF (async, host-side) and write to disk.
    await mkdir(dirname(destPath), { recursive: true });
    const bytes = await pdf.save();
    await writeFile(destPath, bytes);

    return summarize({
      loadedFrom: undefined,
      wroteTo: destPath,
      readOnly: false,
      returnValue,
      droppedChars: [...droppedChars],
      overflow: overflow.getOverflow(),
    });
  },
};

/** Validate args: `script` is required. */
function parseArgs(args: unknown): Args {
  if (!args || typeof args !== "object") {
    throw new Error("arguments must be an object");
  }
  const input = args as Record<string, unknown>;

  const script = input.script;
  if (typeof script !== "string" || script.trim() === "") {
    throw new Error("`script` is required and must be a non-empty string");
  }

  const out: Args = { script };
  if (input.path !== undefined) {
    if (typeof input.path !== "string" || input.path.trim() === "") {
      throw new Error("`path` must be a non-empty string when provided");
    }
    out.path = input.path;
  }
  if (input.saveAs !== undefined) {
    if (typeof input.saveAs !== "string" || input.saveAs.trim() === "") {
      throw new Error("`saveAs` must be a non-empty string when provided");
    }
    out.saveAs = input.saveAs;
  }
  if (input.readOnly !== undefined) {
    if (typeof input.readOnly !== "boolean") {
      throw new Error("`readOnly` must be a boolean when provided");
    }
    out.readOnly = input.readOnly;
  }
  return out;
}

/**
 * Resolve a SOURCE (read) path against either the per-session upload dir (tmp)
 * or the project sandbox. Mirrors excel_script/docx_script's resolveSourcePath.
 */
async function resolveSourcePath(ctx: ToolContext, p: string): Promise<string> {
  if (ctx.uploadDir && isAbsolute(p)) {
    try {
      return await resolveWithin(ctx.uploadDir, p);
    } catch {
      // Absolute path not inside the upload dir — fall through to project sandbox.
    }
  }
  return resolveWithin(ctx.projectDir, p);
}

/**
 * Recursively rebuild a value into the HOST realm: plain Array/Object built
 * from the host constructors. Required because the sandbox runs in its own V8
 * realm — an array literal `[595, 842]` or options object written by the AI has
 * the SANDBOX's prototype, NOT the host's. pdf-lib validates inputs with
 * `instanceof Array` / `instanceof Object`, which silently FAILS across realms
 * (cross-realm instanceof returns false), producing confusing errors like
 * "page must be of type n... was actually NaN". Rebuilding the args here, in
 * the host realm, before handing them to pdf-lib sidesteps every such check.
 *
 * Primitives pass through unchanged. Plain-looking objects and arrays are
 * rebuilt; values that look like host class instances (constructor name isn't
 * "Object"/"Array", e.g. a PDFPage or Color) are left as-is so their own
 * internal methods keep working.
 *
 * NOTE: we intentionally do NOT compare prototype identity against host
 * `Object.prototype` — that check would miss cross-realm plain objects (their
 * prototype is the *sandbox's* Object.prototype, a different object), leaving
 * them unconverted. Instead we treat any non-array object whose constructor
 * name is "Object" as a plain data object and rebuild it.
 */
function toHostValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  // Arrays: rebuild with host Array, recursing into elements.
  if (Array.isArray(v)) {
    return Array.from(v as unknown[], toHostValue);
  }
  // Detect a plain data object (vs a host class instance like PDFPage/Color).
  // Use the constructor name rather than prototype identity so cross-realm
  // plain objects ({ x, y }) are still recognized and rebuilt.
  const ctorName = (v as { constructor?: { name?: string } }).constructor?.name;
  if (ctorName === "Object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>)) {
      out[key] = toHostValue((v as Record<string, unknown>)[key]);
    }
    return out;
  }
  // Non-plain object (class instance): leave as-is.
  return v;
}

/**
 * Wrap a PDFDocument so that:
 *   1. `addPage` accepts cross-realm arrays (e.g. `[595, 842]` from the
 *      sandbox) by rebuilding them in the host realm first.
 *   2. Every PDFPage it returns has its draw methods (drawText, drawLine,
 *      drawRectangle, drawEllipse, drawImage, drawSquare, drawCircle) wrapped
 *      to rebuild their options objects in the host realm. drawLine in
 *      particular validates nested `start`/`end` objects and fails across realms.
 *   3. drawText/drawRectangle calls are tracked for right/bottom-edge overflow
 *      past the page width/height, so the host can warn the AI that its layout
 *      spills outside the page (the most common cause of "content cut off on
 *      the right" — the AI allocates column widths that don't fit).
 *
 * The wrappers rebuild args via `toHostValue` (a deep copy to host objects),
 * then call the original method with host-realm values — pdf-lib's internal
 * calls between its own methods are untouched (they already use host objects),
 * so there is no infinite recursion.
 */
function wrapPdf(pdf: PDFDocument): {
  pdf: PDFDocument;
  overflow: OverflowTracker;
} {
  const overflow = new OverflowTracker();
  const origAddPage = pdf.addPage.bind(pdf);
  (pdf as PDFDocument).addPage = ((arg?: unknown) => {
    const page = origAddPage(arg === undefined ? undefined : (toHostValue(arg) as never));
    wrapPageDrawMethods(page, overflow);
    return page;
  }) as PDFDocument["addPage"];
  return { pdf, overflow };
}

/** Tracks text/shapes drawn outside the page bounds, for layout warnings. */
class OverflowTracker {
  /** Max right edge (x + width) seen on any page, keyed by page number. */
  private readonly rightEdges = new Map<number, { edge: number; pageWidth: number }>();
  private pageCount = 0;

  recordPage(): number {
    return ++this.pageCount;
  }

  noteDraw(pageNum: number, pageWidth: number, rightEdge: number): void {
    const prev = this.rightEdges.get(pageNum);
    if (!prev || rightEdge > prev.edge) {
      this.rightEdges.set(pageNum, { edge: rightEdge, pageWidth });
    }
  }

  /** Returns overflow details for any page where content exceeded the width. */
  getOverflow(): { pageNum: number; edge: number; pageWidth: number; overBy: number }[] {
    const out: { pageNum: number; edge: number; pageWidth: number; overBy: number }[] = [];
    for (const [pageNum, { edge, pageWidth }] of this.rightEdges) {
      // Allow a small tolerance (1pt) for floating point.
      if (edge > pageWidth + 1) {
        out.push({ pageNum, edge, pageWidth, overBy: Math.round(edge - pageWidth) });
      }
    }
    return out.sort((a, b) => a.pageNum - b.pageNum);
  }
}

/** Names of PDFPage methods that take option objects (host-realm normalized). */
const DRAW_METHOD_NAMES = [
  "drawText", "drawRectangle", "drawLine", "drawEllipse",
  "drawImage", "drawSquare", "drawCircle",
] as const;

/**
 * Wrap a PDFPage's draw methods to rebuild their args in the host realm. Safe
 * from infinite recursion because we only intercept the TOP-LEVEL call from
 * the sandbox; internal pdf-lib calls bypass these wrappers (they operate on
 * the original, host-realm objects).
 *
 * For drawText and drawRectangle, also record the right edge (x + content
 * width) so the host can detect content spilling past the page width and warn
 * the model — this catches the common "table cut off on the right" mistake
 * where the AI's column widths don't add up to fit the page.
 */
function wrapPageDrawMethods(page: import("pdf-lib").PDFPage, overflow: OverflowTracker): void {
  const pageAny = page as unknown as Record<string, Function>;
  const pageNum = overflow.recordPage();
  const pageWidth = page.getWidth();

  for (const name of DRAW_METHOD_NAMES) {
    const original = pageAny[name];
    if (typeof original !== "function") continue;
    pageAny[name] = function (...args: unknown[]): unknown {
      const normalized = args.map((a) => (a === undefined ? a : toHostValue(a)));
      // Track the rightmost edge for overflow detection.
      const opts = (normalized[0] ?? normalized[1]) as Record<string, unknown> | undefined;
      if (opts && typeof opts === "object") {
        const x = numOr(opts.x, 0);
        if (name === "drawText") {
          const text = String(opts.text ?? "");
          const size = numOr(opts.size, 12);
          // Approx width via font.widthOfTextAtSize if a font is provided;
          // otherwise estimate (cannot measure without font). We use the
          // page's drawText font (the pre-embedded Helvetica) — opts.font.
          const font = opts.font as { widthOfTextAtSize?: (t: string, s: number) => number } | undefined;
          const w = font?.widthOfTextAtSize ? font.widthOfTextAtSize(text, size) : text.length * size * 0.5;
          overflow.noteDraw(pageNum, pageWidth, x + w);
        } else if (name === "drawRectangle" || name === "drawImage" || name === "drawSquare") {
          const w = numOr(opts.width, 0);
          overflow.noteDraw(pageNum, pageWidth, x + w);
        }
      }
      return original.apply(page, normalized);
    };
  }
}

/** Coerce to a finite number, falling back to `fallback`. */
function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Extract text from every page of a PDF using pdfjs-dist (Mozilla PDF.js).
 * Pages are joined with a form-feed (`\f`) separator so the script can split
 * per-page. pdfjs-dist is loaded lazily via createRequire (it's an ESM-ish
 * package with a legacy CJS-compatible build; loading it this way avoids
 * bundler issues in Electron/VSCode).
 */
async function extractPdfText(data: Buffer): Promise<string> {
  // Resolve the legacy build path. pdfjs-dist's main build is browser-only;
  // the legacy build works in Node without a DOM.
  const req = createRequire(requireBaseUrl());
  const pdfjsPath = req.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjsDir = dirname(pdfjsPath);
  const pdfjs = req(pdfjsPath);

  // Configure the worker + standard font data so pdfjs doesn't warn/crash.
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(pdfjsDir + "/pdf.worker.mjs").href;
  const pkgRoot = dirname(pdfjsDir) === pdfjsDir ? pdfjsDir : dirname(dirname(pdfjsPath));
  let standardFontDataUrl: string | undefined;
  try {
    standardFontDataUrl = pathToFileURL(pkgRoot + "/standard_fonts/").href;
  } catch {
    // best-effort; missing font data only affects non-embedded font rendering,
    // not text extraction.
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
    // Suppress noisy console warnings about unhandled annotations/metadata.
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: { str?: string }) => item.str ?? "")
      .join(" ");
    pages.push(pageText);
  }
  try {
    await doc.destroy();
  } catch {
    // ignore cleanup errors
  }
  return pages.join("\f");
}

/** Minimal safe globals shared by both read and create sandboxes. */
function baseSandbox(): Record<string, unknown> {
  return {
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Symbol,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    // Security blocks: shadow host globals.
    require: undefined,
    process: undefined,
    global: undefined,
    globalThis: undefined,
    Promise: undefined,
  };
}

/**
 * Wrap a pdf-lib font's `encodeText` so it no longer throws on characters the
 * WinAnsi-encoded standard font (Helvetica) cannot represent — emoji (❤😀),
 * CJK, dingbats, etc. Such characters are replaced with '?' (the conventional
 * PDF "missing glyph" fallback) and recorded in `droppedChars` so the host can
 * warn the model.
 *
 * The original encoding throws `WinAnsi cannot encode "❤" (0x2764)`, which
 * aborts the whole script. By per-character probing, only the unsupported
 * glyphs are lost — everything else renders normally.
 *
 * Returns the patched font (same object, method replaced) plus a mutable Set
 * the caller reads after the script runs.
 */
function patchFontEncoding(font: PDFFont): {
  patchedFont: PDFFont;
  droppedChars: Set<string>;
} {
  const droppedChars = new Set<string>();
  const originalEncode = font.encodeText.bind(font);
  const probeCache = new Map<string, boolean>();

  const canEncode = (ch: string): boolean => {
    const cached = probeCache.get(ch);
    if (cached !== undefined) return cached;
    let ok = true;
    try {
      originalEncode(ch);
    } catch {
      ok = false;
    }
    probeCache.set(ch, ok);
    return ok;
  };

  (font as PDFFont).encodeText = (text: string) => {
    try {
      return originalEncode(text);
    } catch {
      // Fall back to per-character encoding, replacing un-encodable glyphs.
      const chars = Array.from(text);
      let anyDropped = false;
      const safe = chars
        .map((ch) => {
          if (canEncode(ch)) return ch;
          anyDropped = true;
          droppedChars.add(ch);
          return "?";
        })
        .join("");
      if (anyDropped) return originalEncode(safe);
      return originalEncode(text);
    }
  };

  return { patchedFont: font, droppedChars };
}

/**
 * Run a CREATE-mode script: `(pdf, P, font) => { ... }`. The script mutates `pdf`
 * (adding pages, drawing) and may return a summary. `P` is the pdf-lib module
 * (for rgb/degrees/PageSizes/etc); `font` is a pre-embedded Helvetica so the
 * script can call drawText without async embedFont.
 */
function runCreateScript(pdf: PDFDocument, font: unknown, script: string): unknown {
  const sandbox: Record<string, unknown> = {
    ...baseSandbox(),
    pdf,
    P: { PDFDocument, StandardFonts, rgb, degrees, PageSizes },
    font,
    __result: undefined,
  };
  return runInSandbox(sandbox, script, ["pdf", "P", "font"]);
}

/**
 * Run a READ-mode script: `(text) => { ... return data }`. The script receives
 * the extracted PDF text and returns processed data.
 */
function runReadScript(text: string, script: string): unknown {
  const sandbox: Record<string, unknown> = {
    ...baseSandbox(),
    text,
    __result: undefined,
  };
  return runInSandbox(sandbox, script, ["text"]);
}

/**
 * Execute the user-supplied script in a locked-down V8 context (identical to
 * excel_script / docx_script). See those tools for the security rationale.
 */
function runInSandbox(
  sandbox: Record<string, unknown>,
  script: string,
  argNames: string[],
): unknown {
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  const argsList = argNames.join(", ");
  const wrapper = `(function () {
    var __fn = (${script});
    if (typeof __fn !== "function") {
      throw new Error("script must evaluate to a function, got " + (typeof __fn));
    }
    __result = __fn(${argsList});
  })();`;

  try {
    vm.runInContext(wrapper, context, { timeout: SCRIPT_TIMEOUT_MS });
  } catch (err) {
    throw wrapScriptError(err);
  }
  return sandbox.__result;
}

/** Turn a raw VM error into a clean message, enriching pdf-lib validation
 * errors with actionable guidance (the most common AI script mistakes). */
function wrapScriptError(err: unknown): Error {
  const e = err as NodeJS.ErrnoException & { code?: string };
  if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
    return new Error(`script timed out (>${SCRIPT_TIMEOUT_MS}ms). Possible infinite loop.`);
  }
  if (e.code === "ERR_VM_CONSTRAINT") {
    return new Error(
      `script violated sandbox constraints (e.g. used eval or new Function, which are disabled).`,
    );
  }
  let msg = (err as Error).message ?? String(err);

  // pdf-lib validation errors commonly stem from two AI mistakes. Detect them
  // and append a fix so the model can correct its script on retry.
  const mentions = (s: string) => msg.includes(s);
  const isNumericValidation =
    mentions("must be of type `number`") ||
    mentions("must be of type `number` or `n`") ||
    mentions("was actually of type `NaN`") ||
    mentions("was actually of type `undefined`");
  if (isNumericValidation) {
    // Extract the offending field name from "X must be of type..." or the NaN note.
    const fieldMatch = msg.match(/`([a-zA-Z_.]+)`\s+must be of type/);
    const field = fieldMatch ? fieldMatch[1] : "a field";
    msg +=
      `\n\n--- FIX HINT ---\n` +
      `This "${field}" value is NaN or undefined. The usual cause is guessing text width ` +
      `with \`text.length * size * 0.5\` where size/text is undefined, OR accessing a missing ` +
      `array cell (\`row[c]\` where c is out of bounds). Do NOT estimate widths — use the exact ` +
      `API: \`font.widthOfTextAtSize(text, size)\` returns the real width in points. Also guard ` +
      `missing cells with \`(row[c] ?? '')\` and default size (\`size ?? 10\`).`;
  }
  return new Error(`script error: ${msg}`);
}

/** Build the human-readable + JSON result string reported back to the model. */
function summarize(opts: {
  loadedFrom?: string;
  wroteTo?: string;
  readOnly: boolean;
  returnValue: unknown;
  /** Chars the WinAnsi standard font couldn't encode (replaced with '?'). */
  droppedChars?: string[];
  /** Pages where content (text/rect right edge) overflowed the page width. */
  overflow?: { pageNum: number; edge: number; pageWidth: number; overBy: number }[];
}): string {
  const { loadedFrom, wroteTo, readOnly, returnValue, droppedChars, overflow } = opts;
  const lines: string[] = [];

  if (loadedFrom) {
    lines.push(`Read ${loadedFrom}`);
  }
  if (wroteTo) {
    lines.push(`Wrote ${wroteTo} (.pdf)`);
  } else if (readOnly) {
    lines.push(`(read-only — PDF not written)`);
  }

  // Warn about characters that were lost (emoji/CJK/etc. the standard font
  // cannot encode). This is the model's signal that the PDF doesn't contain
  // them verbatim — useful so it can retry with ASCII-safe alternatives.
  if (droppedChars && droppedChars.length > 0) {
    const display = droppedChars.map((c) => `"${c}"`).join(", ");
    lines.push(
      `WARNING: ${droppedChars.length} character type(s) could not be rendered by the ` +
        `standard PDF font (WinAnsi/Helvetica) and were replaced with '?': ${display}. ` +
        `Emoji, CJK, and non-Latin scripts are NOT supported by standard PDF fonts — ` +
        `use ASCII-safe equivalents.`,
    );
  }

  // Warn about layout overflow — content drawn past the right page edge. This is
  // the "content cut off on the right" problem: the AI's column/element widths
  // sum to more than (pageWidth - leftMargin). Surface exactly how far over, and
  // which page, so the model can shrink widths / reduce font size / use landscape.
  if (overflow && overflow.length > 0) {
    const parts = overflow.map(
      (o) => `page ${o.pageNum} (content reached x=${Math.round(o.edge)}pt, page is ${o.pageWidth}pt wide — over by ${o.overBy}pt)`,
    );
    lines.push(
      `WARNING: layout overflow — content spills past the right page edge: ${parts.join("; ")}. ` +
        `The rightmost content is cut off. FIX: reduce column widths / element sizes so the total ` +
        `fits within (pageWidth - leftMargin - rightMargin), lower the font size, or use a wider page ` +
        `(e.g. pdf.addPage(P.PageSizes.A4) rotated, or [842, 595] for A4 landscape). Verify with ` +
        `font.widthOfTextAtSize(text, size) that each column's widest value fits its allocated width.`,
    );
  }

  if (returnValue !== undefined) {
    let json: string;
    try {
      json = JSON.stringify(returnValue, jsonReplacer, 2);
    } catch {
      json = String(returnValue);
    }
    if (json === undefined) json = String(returnValue);
    if (json.length > MAX_RETURN_CHARS) {
      json = json.slice(0, MAX_RETURN_CHARS) +
        `\n... [truncated ${json.length - MAX_RETURN_CHARS} chars]`;
    }
    lines.push(`--- script return value ---`, json);
  }
  return lines.join("\n");
}

/** JSON replacer: coerce non-serializable values (functions, buffers) safely. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "function") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
    return `[ArrayBuffer ${value.byteLength} bytes]`;
  }
  if (ArrayBuffer.isView(value)) {
    return `[${(value as Uint8Array).constructor.name} ${(value as Uint8Array).byteLength} bytes]`;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}
