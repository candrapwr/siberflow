import vm from "node:vm";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
// `docx` ships as ESM with named exports (no default). Under NodeNext we use a
// namespace import to grab the whole module surface (Document, Paragraph,
// Packer, TextRun, HeadingLevel, Table, ...).
import * as docxLib from "docx";
// `mammoth` ships as CommonJS with named exports (no default).
import * as mammothLib from "mammoth";
import type { Tool, ToolContext } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";

interface Args {
  /** Where the document is loaded from (read mode) AND/OR written back to. */
  path?: string;
  /** Optional explicit destination path (overrides `path` for the write). */
  saveAs?: string;
  /** The JS function expression. Required. */
  script: string;
  /** Read-only mode: load existing .docx via mammoth → HTML, don't write. */
  readOnly?: boolean;
}

/** Max wall-clock time for a script, in ms. Prevents runaway loops. */
const SCRIPT_TIMEOUT_MS = 5000;
/** Cap on the JSON-stringified return value sent back to the model. */
const MAX_RETURN_CHARS = 200_000;

export const docxScriptTool: Tool = {
  name: "docx_script",
  description:
    "Create or read a Word (.docx) document by running a JavaScript function you supply, " +
    "with full access to the `docx` library API (create mode) or the HTML content of an existing " +
    "document (read mode). This is the single tool for Word document work.\n\n" +
    "MODES:\n" +
    "• Create a new document: pass `saveAs` (or `path`) + a script that builds the document via the " +
    "`docx` API. Signature: `(doc, docx) => { ... }` where `doc` is a fresh empty `Document` and " +
    "`docx` is the `docx` library module (giving you `Paragraph`, `TextRun`, `HeadingLevel`, " +
    "`Table`, `TableRow`, `TableCell`, `ImageRun`, `AlignmentType`, `Packer`, etc.). Mutate `doc` " +
    "(typically by adding sections with `doc.addSection({...})` or by constructing it with sections). " +
    "The host serializes `doc` to .docx via `docx.Packer.toBuffer` and writes it to `path`/`saveAs` " +
    "after the script runs — you never touch the filesystem.\n" +
    "• Read an existing document: pass `path` + `readOnly: true`. The host loads the .docx via " +
    "mammoth and converts it to HTML, then passes that HTML STRING to your script as the first arg. " +
    "Signature: `(html) => { ... return data }`. Extract whatever you need (tables, headings, word " +
    "counts, structure) and RETURN it — the return value is serialized to JSON and sent back to you " +
    "as the tool result.\n\n" +
    "CREATING — common patterns:\n" +
    "• Heading: `new docx.Paragraph({ heading: docx.HeadingLevel.HEADING_1, children: [new docx.TextRun('Title')] })`\n" +
    "• Styled text: `new docx.TextRun({ text: 'bold red', bold: true, color: 'FF0000', size: 24 })` " +
    "(size is in half-points: 24 = 12pt)\n" +
    "• Bullet list: `new docx.Paragraph({ text: 'item', bullet: { level: 0 } })`\n" +
    "• Table: `new docx.Table({ rows: [ new docx.TableRow({ children: [ new docx.TableCell({ children: [new docx.Paragraph('cell')] }) ] }) ] })`\n" +
    "• Image: `new docx.ImageRun({ data: <Uint8Array/Buffer>, transformation: { width: 200, height: 200 } })`. " +
    "The sandbox blocks `fs`, so to embed an image read its bytes OUTSIDE this tool first (e.g. via " +
    "read_file) and inline them as a Uint8Array literal in the script.\n\n" +
    "READING — the HTML you receive is mammoth's semantic conversion: headings become <h1>-<h6>, " +
    "paragraphs <p>, tables <table>, lists <ul>/<ol>. Note: exact visual formatting (fonts, colors, " +
    "margins) is NOT preserved — mammoth extracts structure/content, not styling.\n\n" +
    "The script MUST be synchronous (return a plain value, not a Promise). The host performs all " +
    "async I/O (loading, mammoth conversion, Packer serialization, writing) outside the sandbox. " +
    "The sandbox blocks `require`, `process`, `fs`, network, `eval`, `Function`, and `Promise`; " +
    "execution is capped at 5 seconds. On error, the message is returned so you can fix and retry.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Document to read (when readOnly:true) OR the destination to write (create mode). In read " +
          "mode the file must exist; in create mode it is written here (overwriting if present). " +
          "Absolute or relative to project dir.",
      },
      saveAs: {
        type: "string",
        description:
          "Optional explicit destination path for create mode (overrides `path` for the write). Must " +
          "be inside the project sandbox.",
      },
      script: {
        type: "string",
        description:
          "A synchronous JavaScript function expression.\n" +
          "Create mode: `(doc, docx) => { ... }` — build the document, no return needed (or return a " +
          "summary string).\n" +
          "Read mode: `(html) => { ... return data }` — extract data from the HTML string and return it.\n" +
          "Examples —\n" +
          "Create: \"(doc, docx) => { doc.addSection({ children: [ new docx.Paragraph({ heading: docx.HeadingLevel.HEADING_1, children: [new docx.TextRun('Report')] }), new docx.Paragraph('Body text') ] }); }\"\n" +
          "Read: \"(html) => { const headings = (html.match(/<h[1-6][^>]*>(.*?)<\\/h[1-6]>/g) || []).map(h => h.replace(/<[^>]+>/g,'')); return { headingCount: headings.length, headings }; }\"",
      },
      readOnly: {
        type: "boolean",
        description:
          "If true: read mode. The .docx at `path` is loaded and converted to HTML, passed to the " +
          "script; nothing is written to disk. Default false (create mode).",
      },
    },
    required: ["script"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = parseArgs(args);

    // ----- READ MODE -------------------------------------------------------
    // Host loads the .docx and converts via mammoth (async, can't run in the
    // sync sandbox). The resulting HTML string is handed to the script.
    if (parsed.readOnly === true) {
      if (!parsed.path) {
        throw new Error("`path` is required in read mode (the .docx to read).");
      }
      const loadPath = await resolveSourcePath(ctx, parsed.path);
      const buffer = await readFile(loadPath);

      // mammoth is CommonJS; the default export holds the functions.
      const result = await mammothLib.convertToHtml({ buffer });
      const html = result.value;

      // Run the script against the HTML string; surface its return value.
      const returnValue = runReadScript(html, parsed.script);
      return summarize({ loadedFrom: loadPath, wroteTo: undefined, readOnly: true, returnValue });
    }

    // ----- CREATE MODE -----------------------------------------------------
    const target = parsed.saveAs ?? parsed.path;
    if (!target) {
      throw new Error(
        "`path` or `saveAs` is required in create mode (the destination .docx). Pass readOnly:true " +
          "for a read-only script.",
      );
    }
    const destPath = await resolveWithin(ctx.projectDir, target);

    // Build a fresh Document. The script populates it via the docx API
    // (typically `doc.addSection({...})`). Start with empty sections so the
    // script can build the structure from scratch.
    const doc = new docxLib.Document({
      creator: "siberflow",
      title: "Siberflow Document",
      description: "Generated by siberflow docx_script",
      sections: [],
    });

    // Run the user script against the fresh Document + docx module.
    const returnValue = runCreateScript(doc, parsed.script);

    // Serialize to .docx via Packer (async, host-side) and write to disk.
    await mkdir(dirname(destPath), { recursive: true });
    const packed = await docxLib.Packer.toBuffer(doc);
    await writeFile(destPath, packed);

    return summarize({ loadedFrom: undefined, wroteTo: destPath, readOnly: false, returnValue });
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
 * or the project sandbox. Mirrors excel_script's resolveSourcePath — allows
 * reading uploaded files if uploadDir is set, else stays in the project sandbox.
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
 * Run a CREATE-mode script: `(doc, docx) => { ... }`. The script mutates `doc`
 * (adding sections/paragraphs) and may return a summary. Returns whatever the
 * script returns (or undefined).
 */
function runCreateScript(doc: unknown, script: string): unknown {
  const sandbox: Record<string, unknown> = {
    ...baseSandbox(),
    doc,
    docx: docxLib,
    __result: undefined,
  };
  return runInSandbox(sandbox, script, ["doc", "docx"]);
}

/**
 * Run a READ-mode script: `(html) => { ... return data }`. The script receives
 * the mammoth-converted HTML string and returns extracted data.
 */
function runReadScript(html: string, script: string): unknown {
  const sandbox: Record<string, unknown> = {
    ...baseSandbox(),
    html,
    __result: undefined,
  };
  return runInSandbox(sandbox, script, ["html"]);
}

/**
 * Execute the user-supplied script in a locked-down V8 context. The wrapper
 * type-checks the script evaluates to a function, invokes it with the named
 * args, and stores the return value in `__result` for the host to read back.
 *
 * Security: `codeGeneration.strings:false` disables eval/Function; dangerous
 * globals are shadowed; a 5s timeout bounds execution. The wrapper + script
 * source are compiled together (static compilation), so the codegen block
 * still applies. Brackets around the script let both arrow and `function`
 * expressions parse as expressions.
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

/** Turn a raw VM error into a clean message. */
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
  const msg = (err as Error).message ?? String(err);
  return new Error(`script error: ${msg}`);
}

/** Build the human-readable + JSON result string reported back to the model. */
function summarize(opts: {
  loadedFrom?: string;
  wroteTo?: string;
  readOnly: boolean;
  returnValue: unknown;
}): string {
  const { loadedFrom, wroteTo, readOnly, returnValue } = opts;
  const lines: string[] = [];

  if (loadedFrom) {
    lines.push(`Read ${loadedFrom}`);
  }
  if (wroteTo) {
    lines.push(`Wrote ${wroteTo} (.docx)`);
  } else if (readOnly) {
    lines.push(`(read-only — document not written)`);
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
