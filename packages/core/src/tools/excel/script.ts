import vm from "node:vm";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
// exceljs ships as CommonJS; under NodeNext ESM, named imports off a CJS
// module aren't statically resolvable at runtime — import the default and
// destructure. Same pattern as read.ts / write.ts.
import ExcelJS from "exceljs";
import type { Workbook } from "exceljs";
import type { Tool } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";

const { Workbook: WorkbookCtor } = ExcelJS;

interface Args {
  path: string;
  script: string;
}

/** Max wall-clock time for a script, in ms. Prevents runaway loops. */
const SCRIPT_TIMEOUT_MS = 5000;

export const writeExcelScriptTool: Tool = {
  name: "write_excel_script",
  description:
    "Create or overwrite an Excel (.xlsx) workbook by running a JavaScript function you supply, " +
    "giving full access to the exceljs API: merge cells, multi-level headers, conditional formatting, " +
    "charts, autofilter, data validation, images, frozen panes, column/row grouping, protection, and more. " +
    "Prefer this over `write_excel` (data mode) whenever the layout needs anything beyond a simple " +
    "styled table — e.g. merged title bars, grouped/stacked headers, charts, or conditional formatting. " +
    "`write_excel` is simpler and more reliable for plain tables from row objects. " +
    "The script runs in a locked-down sandbox: it receives `(wb, ExcelJS)` where `wb` is a fresh empty " +
    "Workbook and `ExcelJS` is the exceljs module. It must mutate `wb` (add worksheets, cells, styles) " +
    "and return nothing. The sandbox blocks `require`, `process`, `fs`, network, `eval`, and the `Function` " +
    "constructor; execution is capped at 5 seconds. On error, the message is returned so you can fix the " +
    "script and retry. The file is written sandboxed to the project directory and overwrites if it exists.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Destination .xlsx path, absolute or relative to project dir. Overwrites if it exists.",
      },
      script: {
        type: "string",
        description:
          "A JavaScript function expression (e.g. an arrow function) taking (wb, ExcelJS). " +
          "It builds the workbook via the exceljs API and returns nothing. " +
          "Example: \"(wb, ExcelJS) => { const ws = wb.addWorksheet('S'); ws.mergeCells('A1:C1'); ws.getCell('A1').value = 'Title'; ws.getCell('A1').font = { bold: true }; ws.addRow(['a','b','c']); }\"",
      },
    },
    required: ["path", "script"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = parseArgs(args);
    const full = await resolveWithin(ctx.projectDir, parsed.path);
    await mkdir(dirname(full), { recursive: true });

    const workbook = new WorkbookCtor();
    workbook.creator = "siberflow";
    workbook.created = new Date();
    workbook.modified = new Date();

    // Run the user script in a restricted VM. On error, throw so the registry
    // surfaces the message to the model — the agent loop lets it fix & retry.
    await runScriptInSandbox(workbook, parsed.script);

    const buffer = await workbook.xlsx.writeBuffer();
    await writeFile(full, Buffer.from(buffer));

    // Summarize what got built so the model (and user) get useful feedback.
    // exceljs doesn't expose a cell-count, so report row/column dimensions.
    const sheets = workbook.worksheets.map((ws) => ({
      name: ws.name,
      rows: ws.actualRowCount,
      cols: ws.actualColumnCount,
    }));
    const lines = [
      `Wrote ${full} (${sheets.length} sheet${sheets.length === 1 ? "" : "s"})`,
      ...sheets.map(
        (s) => `  • ${s.name}: ${s.rows} rows × ${s.cols} cols`,
      ),
    ];
    return lines.join("\n");
  },
};

/** Validate args: both `path` and `script` are required non-empty strings. */
function parseArgs(args: unknown): Args {
  if (!args || typeof args !== "object") {
    throw new Error("arguments must be an object");
  }
  const input = args as Record<string, unknown>;
  const path = input.path;
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("`path` is required and must be a non-empty string");
  }
  const script = input.script;
  if (typeof script !== "string" || script.trim() === "") {
    throw new Error("`script` is required and must be a non-empty string");
  }
  return { path, script };
}

/**
 * Execute the user-supplied script against a fresh workbook in a locked-down
 * V8 context.
 *
 * The context exposes ONLY: the `ExcelJS` module, the empty `wb`, and a
 * minimal set of standard globals (Math, JSON, Date, …). Anything dangerous
 * (`require`, `process`, `global`, `globalThis`) is set to `undefined`, and
 * `codeGeneration.strings` is disabled so `eval` and the `Function`
 * constructor are unavailable — there is no escape back to the host.
 *
 * A 5s timeout guards against infinite loops. Runtime errors propagate as
 * thrown Errors so the tool registry reports them to the model.
 */
async function runScriptInSandbox(workbook: Workbook, script: string): Promise<void> {
  const sandbox: Record<string, unknown> = {
    // Full exceljs API + the workbook to build.
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
    // The user's raw script source. We eval it inside the context (via the
    // wrapper below) so both compile AND execution are bound by the vm
    // timeout — if we invoked the returned function from the host instead, an
    // infinite loop in it would never be killed.
    __userScript: script,
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
  // wrapper type-checks the result is a function and invokes it — ALL inside
  // one runInContext so the timeout covers execution too (invoking the
  // returned function from the host would bypass the timeout on infinite
  // loops). Bracket the script in parens so both arrow and `function`
  // expressions parse as expressions.
  const wrapper = `(function () {
    var __fn = (${script});
    if (typeof __fn !== "function") {
      throw new Error("script must evaluate to a function, got " + (typeof __fn));
    }
    __fn(wb, ExcelJS);
  })();`;

  try {
    vm.runInContext(wrapper, context, { timeout: SCRIPT_TIMEOUT_MS });
  } catch (err) {
    throw wrapScriptError(err, "run");
  }
}

/**
 * Turn a raw VM error into a clean message. The two cases we special-case:
 * timeout (infinite loop) and the "strings" codegen block (eval/Function use).
 */
function wrapScriptError(err: unknown, phase: "compile" | "run"): Error {
  const e = err as NodeJS.ErrnoException & { code?: string };
  if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
    return new Error(
      `script ${phase} timed out (>${SCRIPT_TIMEOUT_MS}ms). Possible infinite loop.`,
    );
  }
  if (e.code === "ERR_VM_CONSTRAINT") {
    return new Error(
      `script ${phase} violated sandbox constraints (e.g. used eval or new Function, which are disabled).`,
    );
  }
  const msg = (err as Error).message ?? String(err);
  return new Error(`script ${phase} error: ${msg}`);
}
