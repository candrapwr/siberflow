import vm from "node:vm";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
// exceljs ships as CommonJS; under NodeNext ESM, named imports off a CJS
// module aren't statically resolvable at runtime — import the default and
// destructure. Same pattern as the legacy read/write tools.
import ExcelJS from "exceljs";
import type { Workbook } from "exceljs";
import type { Tool, ToolContext } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";

const { Workbook: WorkbookCtor } = ExcelJS;

interface Args {
  /** Where the workbook is loaded from (if it exists) AND written back to. */
  path?: string;
  /**
   * Optional destination path. When set, the (possibly loaded+mutated)
   * workbook is written here instead of back to `path`. Useful for
   * "load template X, save as Y". Must be inside the project sandbox.
   */
  saveAs?: string;
  /** The JS function expression. Required. */
  script: string;
  /** Skip writing the workbook back to disk (read-only mode). Default false. */
  readOnly?: boolean;
}

/** Max wall-clock time for a script, in ms. Prevents runaway loops. */
const SCRIPT_TIMEOUT_MS = 5000;
/** Cap on the JSON-stringified return value sent back to the model. */
const MAX_RETURN_CHARS = 200_000;

export const excelScriptTool: Tool = {
  name: "excel_script",
  description:
    "Read, modify, or create an Excel (.xlsx) workbook by running a JavaScript function you supply, " +
    "with full access to the exceljs API: read/write cells, formulas, multiple sheets, merge cells, " +
    "multi-level headers, conditional formatting, charts, images (addImage/getImages), autofilter, data " +
    "validation, frozen panes, column/row grouping, number formats, and styling. This is the single " +
    "tool for ALL Excel work — both reading existing files and creating new ones.\n\n" +
    "MODES:\n" +
    "• Read an existing file: pass `path` + a script that reads from `wb` and RETURNS the data you " +
    "extracted (e.g. `(wb, ExcelJS) => { const ws = wb.getWorksheet('Sheet1'); return ws.getSheetValues(); }`). " +
    "Set `readOnly: true` so the file isn't rewritten. The return value (string|number|object|array) is " +
    "serialized to JSON and sent back to you as the tool result, so you can see what you read.\n" +
    "• Modify an existing file: pass `path` (the workbook is loaded and passed in as `wb`), mutate it " +
    "in the script, omit `readOnly`. The workbook is written back to `path` (or `saveAs`) after the " +
    "script finishes — you never touch the filesystem yourself.\n" +
    "• Create a new file: OMIT `path`, build the workbook from scratch via `wb.addWorksheet(...)`, " +
    "and pass `saveAs` (or `path`) as the destination. The fresh empty `wb` is passed in.\n\n" +
    "SIGNATURE: `(wb, ExcelJS) => { ... return <optional data> }` where `wb` is a Workbook (either " +
    "loaded from `path` or a fresh empty one) and `ExcelJS` is the exceljs module. The function MUST be " +
    "synchronous — return a plain value, not a Promise (the host does all file I/O for you).\n\n" +
    "READING TIPS:\n" +
    "• Formulas: a cell whose value is a formula exposes `{ formula, result }` — read " +
    "`cell.value.formula` for the expression, `cell.value.result` for the cached result.\n" +
    "• Images: `ws.getImages()` returns `[{ type:'image', imageId, range }]`; the backing buffer is " +
    "`wb.getImage(imageId).buffer`.\n" +
    "• Row values: `ws.getSheetValues()` (index 0 is a gap in exceljs — slice(1) to drop it) or " +
    "iterate `ws.eachRow((row) => row.values)`.\n\n" +
    "WRITING TIPS:\n" +
    "• Formula cell: `ws.getCell('C2').value = { formula: 'SUM(A2:A10)' }`.\n" +
    "• Image: `const id = wb.addImage({ buffer, extension:'png' }); ws.addImage(id, 'D2:F8');` — " +
    "`buffer` must be a Buffer/Uint8Array of the image bytes. The sandbox blocks `fs`, so to embed an " +
    "image you must first read its bytes OUTSIDE this tool (e.g. via read_file) and inline the decoded " +
    "Buffer literal in the script source, or build it from data you already have.\n\n" +
    "The script runs in a locked-down sandbox: it receives `(wb, ExcelJS)`. The sandbox blocks `require`, " +
    "`process`, `fs`, network, `eval`, the `Function` constructor, and async/Promise; execution is capped " +
    "at 5 seconds. The host loads the source file (if `path` is given and exists) and writes the result " +
    "back to disk after the script runs — the script itself never touches the filesystem, so file access " +
    "stays sandboxed to the project directory (uploaded files in the session upload dir are also readable). " +
    "On error, the message is returned so you can fix the script and retry.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Workbook to load (read/modify mode) OR the destination to write (create mode, when no " +
          "existing file). If the file exists it is loaded into `wb`; if not, `wb` starts empty and " +
          "is written here. Absolute or relative to project dir. Inside the project sandbox; uploaded " +
          "files (session upload dir) are also readable.",
      },
      saveAs: {
        type: "string",
        description:
          "Optional explicit destination path (overrides `path` for the write). Use when loading " +
          "from `path` but saving elsewhere. Must be inside the project sandbox.",
      },
      script: {
        type: "string",
        description:
          "A synchronous JavaScript function expression taking (wb, ExcelJS). Read mode: return the " +
          "extracted data (it comes back to you as the tool result). Write/modify mode: mutate `wb` " +
          "and optionally return a summary. Examples —\n" +
          "Read: \"(wb, ExcelJS) => { const ws = wb.worksheets[0]; const rows = []; " +
          "ws.eachRow((r) => rows.push(r.values.slice(1))); return { headers: rows[0], data: rows.slice(1) }; }\"\n" +
          "Create: \"(wb, ExcelJS) => { const ws = wb.addWorksheet('Sales'); " +
          "ws.getCell('A1').value = 'Total'; ws.getCell('B1').value = { formula: 'SUM(B2:B10)' }; }\"",
      },
      readOnly: {
        type: "boolean",
        description:
          "If true, never write the workbook back to disk (pure read/inspect). Default false. Set " +
          "this when you only want to extract data from an existing file without modifying it.",
      },
    },
    required: ["script"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = parseArgs(args);

    // Resolve the SOURCE path (for loading). May be undefined in pure-create
    // mode (only saveAs given). Source may live in the project sandbox OR the
    // per-session upload dir (so uploaded Excels are readable).
    let loadPath: string | undefined;
    if (parsed.path) {
      loadPath = await resolveSourcePath(ctx, parsed.path);
    }

    // Resolve the DESTINATION path (for writing). Falls back to `path`.
    const willWrite = parsed.readOnly !== true;
    let destPath: string | undefined;
    if (willWrite) {
      const target = parsed.saveAs ?? parsed.path;
      if (!target) {
        throw new Error(
          "`path` or `saveAs` is required when writing (readOnly not set). Pass readOnly:true for " +
            "a read-only script, or provide a destination path.",
        );
      }
      destPath = await resolveWithin(ctx.projectDir, target);
    }

    // Build the workbook: load existing bytes if a source file is present,
    // otherwise start from a fresh empty workbook.
    const workbook = new WorkbookCtor();
    workbook.creator = "siberflow";
    workbook.created = new Date();
    workbook.modified = new Date();

    let loadedFrom: string | undefined;
    if (loadPath) {
      const data = await readFile(loadPath);
      // Known type-only mismatch: exceljs ships an older @types/node Buffer
      // declaration whose `[SymbolToStringTag]` is 'ArrayBuffer', while
      // @types/node v22+ uses 'Uint8Array'. They are the same runtime object.
      // No cast bridges the structural check, so suppress at the call site.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await workbook.xlsx.load(data as any);
      loadedFrom = loadPath;
    }

    // Run the user script in the sandbox. Whatever it returns is JSONified
    // and reported back to the model.
    const returnValue = runScriptInSandbox(workbook, parsed.script);

    // Persist the workbook back to disk (host does the I/O — sandbox never
    // touches fs). Skipped in read-only mode.
    let wroteTo: string | undefined;
    if (destPath) {
      await mkdir(dirname(destPath), { recursive: true });
      const buffer = await workbook.xlsx.writeBuffer();
      await writeFile(destPath, Buffer.from(buffer));
      wroteTo = destPath;
    }

    return summarize({
      loadedFrom,
      wroteTo,
      workbook,
      readOnly: parsed.readOnly === true,
      returnValue,
    });
  },
};

/** Validate args: `script` is required; at least one of path/saveAs unless readOnly. */
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
 * Resolve a SOURCE (read) path against either the per-session upload dir (tmp,
 * where uploaded Excels land) or the project sandbox.
 *
 * Upload-dir access is granted ONLY for absolute paths that land inside it —
 * relative paths are always resolved against the project sandbox (so a stray
 * `internal.xlsx` doesn't accidentally hit a same-named file in the upload
 * dir). Anything that escapes both is rejected by `resolveWithin`.
 */
async function resolveSourcePath(ctx: ToolContext, p: string): Promise<string> {
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

/**
 * Execute the user-supplied script against the workbook in a locked-down V8
 * context. Returns whatever the script returns (or undefined).
 *
 * The context exposes ONLY: the `ExcelJS` module, the `wb`, and a minimal set
 * of standard globals (Math, JSON, Date, …). Anything dangerous (`require`,
 * `process`, `global`, `globalThis`, `Promise`) is set to `undefined`, and
 * `codeGeneration.strings` is disabled so `eval` and the `Function`
 * constructor are unavailable — there is no escape back to the host.
 *
 * A 5s timeout guards against infinite loops. Runtime errors propagate as
 * thrown Errors so the tool registry reports them to the model. Scripts are
 * required to be synchronous; the exceljs API exposed in the sandbox is
 * entirely synchronous (cell/sheet/style ops). All async I/O (loading and
 * writing the xlsx file) is performed by the host around the sandbox call.
 */
function runScriptInSandbox(workbook: Workbook, script: string): unknown {
  const sandbox: Record<string, unknown> = {
    // Full exceljs API + the workbook to operate on.
    ExcelJS,
    wb: workbook,
    // Minimal standard globals the script may legitimately need.
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
    // Silent console — the model doesn't need our stdout.
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    // Explicit security blocks: shadow any leaked host globals so a script
    // that reaches for them gets `undefined` (a ReferenceError on use).
    require: undefined,
    process: undefined,
    global: undefined,
    globalThis: undefined,
    // Block Promise/async — the sandbox is synchronous-only. If a script
    // declares itself `async`, the returned value would be a Promise the host
    // can't settle from outside the vm; refusing it here gives a clear error
    // rather than a hung tool.
    Promise: undefined,
  };

  const context = vm.createContext(sandbox, {
    // Disable dynamic code generation (eval, new Function) — the primary
    // sandbox-escape vectors. The user's function expression is compiled as
    // part of the wrapper source below (we build the wrapper source string
    // at host time and pass it to runInContext, which is static compilation
    // from the VM's perspective), so this stays safe.
    codeGeneration: { strings: false, wasm: false },
  });

  // Embed the user script directly into the wrapper source. This is static
  // compilation (the whole wrapper string is parsed once by runInContext),
  // NOT runtime eval, so it works under codeGeneration.strings:false. The
  // wrapper type-checks the result is a function, invokes it synchronously,
  // and stores the return value in `__result` so we can pull it back to the
  // host. Bracket the script in parens so both arrow and `function`
  // expressions parse as expressions.
  const wrapper = `(function () {
    var __fn = (${script});
    if (typeof __fn !== "function") {
      throw new Error("script must evaluate to a function, got " + (typeof __fn));
    }
    __result = __fn(wb, ExcelJS);
  })();`;

  // Slot for the script's return value (set by the wrapper above).
  sandbox.__result = undefined;

  try {
    vm.runInContext(wrapper, context, {
      timeout: SCRIPT_TIMEOUT_MS,
    });
  } catch (err) {
    throw wrapScriptError(err);
  }

  // Pull the return value back to the host. exceljs cell/worksheet objects
  // are not plain JSON; `summarize()` coerces them via a replacer.
  return sandbox.__result;
}

/**
 * Turn a raw VM error into a clean message. The two cases we special-case:
 * timeout (infinite loop) and the "strings" codegen block (eval/Function use).
 */
function wrapScriptError(err: unknown): Error {
  const e = err as NodeJS.ErrnoException & { code?: string };
  if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
    return new Error(
      `script timed out (>${SCRIPT_TIMEOUT_MS}ms). Possible infinite loop.`,
    );
  }
  if (e.code === "ERR_VM_CONSTRAINT") {
    return new Error(
      `script violated sandbox constraints (e.g. used eval or new Function, which are disabled).`,
    );
  }
  const msg = (err as Error).message ?? String(err);
  return new Error(`script error: ${msg}`);
}

/** Build the human-readable + JSON result string reported back to the model. */
function summarize(opts: {
  loadedFrom?: string;
  wroteTo?: string;
  workbook: Workbook;
  readOnly: boolean;
  returnValue: unknown;
}): string {
  const { loadedFrom, wroteTo, workbook, readOnly, returnValue } = opts;

  const lines: string[] = [];

  if (loadedFrom) {
    lines.push(`Loaded ${loadedFrom}`);
  }
  if (wroteTo) {
    const sheets = workbook.worksheets.map((ws) => ({
      name: ws.name,
      rows: ws.actualRowCount,
      cols: ws.actualColumnCount,
    }));
    lines.push(
      `Wrote ${wroteTo} (${sheets.length} sheet${sheets.length === 1 ? "" : "s"})`,
      ...sheets.map(
        (s) => `  • ${s.name}: ${s.rows} rows × ${s.cols} cols`,
      ),
    );
  } else if (readOnly) {
    lines.push(`(read-only — workbook not written)`);
  }

  // Surface the script's return value (if any) so the model can see what it
  // read/computed. JSON.stringify with a fallback for non-serializable data.
  if (returnValue !== undefined) {
    let json: string;
    try {
      json = JSON.stringify(returnValue, jsonReplacer, 2);
    } catch {
      json = String(returnValue);
    }
    if (json === undefined) json = String(returnValue);
    if (json.length > MAX_RETURN_CHARS) {
      json =
        json.slice(0, MAX_RETURN_CHARS) +
        `\n... [truncated ${json.length - MAX_RETURN_CHARS} chars]`;
    }
    lines.push(`--- script return value ---`, json);
  }

  return lines.join("\n");
}

/**
 * JSON replacer: exceljs objects (Cell, Worksheet, etc.) carry circular refs
 * and methods. Coerce anything that isn't plain JSON-serializable into a
 * short descriptor so the return value never throws or explodes in size.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  // Functions → skip (omit).
  if (typeof value === "function") return undefined;
  // Plain JSON types pass through.
  if (value === null || typeof value !== "object") return value;
  // ArrayBuffers / typed arrays → descriptor (don't dump raw image bytes).
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
    return `[ArrayBuffer ${value.byteLength} bytes]`;
  }
  if (ArrayBuffer.isView(value)) {
    return `[${(value as Uint8Array).constructor.name} ${(value as Uint8Array).byteLength} bytes]`;
  }
  // Dates → ISO.
  if (value instanceof Date) return value.toISOString();
  return value;
}
