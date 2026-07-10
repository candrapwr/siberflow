/**
 * `pdf_script` — create or read PDF documents via Python.
 *
 * CREATE mode: the model supplies a Python script body that uses the
 * `reportlab` library (installed on first use via pip). reportlab uses a
 * natural top-down canvas (`y` starts at top, `doc.drawString` flows
 * downward) — far more intuitive than pdf-lib's bottom-left origin, which
 * eliminates the #1 source of overlapping text. Unicode is fully supported
 * (Helvetica is embedded with full Unicode coverage via reportlab's built-in
 * font handling; no WinAnsi limitation).
 *
 * READ mode: uses `pdfplumber` (or `pypdf` as fallback) to extract text from
 * an existing PDF. For scanned/image PDFs, pass `ocr: true` to run Tesseract.
 *
 * The script runs via the shared `runPython` runner (same as voice tools),
 * with the session workdir as cwd so relative file paths land correctly.
 */
import type { Tool, ToolContext } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";
import { runPython, formatPythonResult } from "../python-runner.js";

interface Args {
  path?: string;
  saveAs?: string;
  script?: string;
  readOnly?: boolean;
  ocr?: boolean;
  ocrLanguage?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export const pdfScriptTool: Tool = {
  name: "pdf_script",
  description:
    "Create or read a PDF document using Python (reportlab for creation, pdfplumber for reading).\n\n" +
    "MODES:\n" +
    "• Create: pass `saveAs` + `script` (Python code). Use `reportlab` to build the PDF. " +
    "The script runs in the session workdir; save the PDF to `saveAs` (relative path). " +
    "reportlab is auto-installed via pip if missing.\n" +
    "• Read: pass `path` + `readOnly: true`. Extracts text via pdfplumber.\n" +
    "• OCR: pass `path` + `ocr: true` for scanned/image PDFs (uses Tesseract).\n\n" +
    "CREATE — reportlab quick reference (natural top-down layout):\n" +
    "```python\n" +
    "from reportlab.lib.pagesizes import A4\n" +
    "from reportlab.lib.units import mm\n" +
    "from reportlab.lib.colors import HexColor\n" +
    "from reportlab.pdfgen import canvas\n" +
    "\n" +
    "c = canvas.Canvas('output.pdf', pagesize=A4)\n" +
    "width, height = A4  # 595, 842 points\n" +
    "y = height - 50  # start near top (50pt margin)\n" +
    "\n" +
    "# Text flows DOWNWARD — decrement y as you go\n" +
    "c.setFont('Helvetica-Bold', 20)\n" +
    "c.drawString(50, y, 'Title Here')\n" +
    "y -= 30\n" +
    "\n" +
    "c.setFont('Helvetica', 11)\n" +
    "c.drawString(50, y, 'Body text...')\n" +
    "y -= 20\n" +
    "\n" +
    "# Shapes\n" +
    "c.setFillColor(HexColor('#1a73e8'))\n" +
    "c.rect(50, y - 40, 495, 40, fill=1, stroke=0)  # x, y_bottom, w, h\n" +
    "c.setFillColor(HexColor('#ffffff'))\n" +
    "c.drawString(60, y - 25, 'Text inside box')\n" +
    "y -= 60\n" +
    "\n" +
    "# Text wrapping (reportlab's stringWidth + manual wrap, or use Paragraph):\n" +
    "from reportlab.lib.utils import simpleSplit\n" +
    "for line in simpleSplit(long_text, 'Helvetica', 11, 495):\n" +
    "    c.drawString(50, y, line)\n" +
    "    y -= 14\n" +
    "\n" +
    "# New page when running low\n" +
    "if y < 60:\n" +
    "    c.showPage()\n" +
    "    y = height - 50\n" +
    "\n" +
    "c.save()\n" +
    "print('PDF created: output.pdf')\n" +
    "```\n" +
    "LAYOUT RULES: y starts at `height - 50` (top). Decrement y after each element. " +
    "Use gaps: title→-30, paragraph line→-14, after box→-(boxHeight+15). " +
    "New page when y < 60. Fonts: Helvetica, Helvetica-Bold, Helvetica-Oblique. " +
    "Unicode/emoji supported natively.\n\n" +
    "READ — extract text from an existing PDF:\n" +
    "```python\n" +
    "import pdfplumber\n" +
    "with pdfplumber.open('input.pdf') as pdf:\n" +
    "    for page in pdf.pages:\n" +
    "        print(page.extract_text())\n" +
    "```\n\n" +
    "FONT LIMITATION: None — reportlab supports full Unicode with Helvetica. " +
    "Emoji and special characters work natively.\n\n" +
    "The script MUST be synchronous Python. Execution is capped at 60 seconds. " +
    "On error (missing library, syntax error), stderr is returned so you can fix and retry. " +
    "reportlab/pdfplumber are auto-installed via pip if missing.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "PDF to read (readOnly:true or ocr:true) OR ignored in create mode (use saveAs instead).",
      },
      saveAs: {
        type: "string",
        description: "Output path for create mode (relative to project dir). E.g. 'report.pdf'.",
      },
      script: {
        type: "string",
        description: "Python script body. Use reportlab (create) or pdfplumber (read).",
      },
      readOnly: {
        type: "boolean",
        description: "Set true to read/extract text from an existing PDF.",
      },
      ocr: {
        type: "boolean",
        description: "Set true to OCR a scanned/image PDF (uses Tesseract). Requires ocrLanguage optionally.",
      },
      ocrLanguage: {
        type: "string",
        description: "Tesseract language for OCR. Default 'ind' (Indonesian). Use 'eng' for English.",
      },
    },
    required: ["script"],
    additionalProperties: false,
  },
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = rawArgs as Args;
    if (!args || typeof args.script !== "string" || !args.script.trim()) {
      return "Error: pdf_script requires a non-empty `script` string.";
    }

    // ── OCR mode: delegate to the existing OCR pipeline (Tesseract) ──
    if (args.ocr) {
      return handleOcr(args, ctx);
    }

    // ── Read mode: prepend a pdfplumber auto-install + extraction wrapper ──
    if (args.readOnly) {
      return handleRead(args, ctx);
    }

    // ── Create mode: run the user's Python script with reportlab available ──
    return handleCreate(args, ctx);
  },
};

/** Ensure reportlab is importable; pip-install silently if missing.
 *  Handles PEP 668 (externally-managed-environment) by trying --break-system-packages. */
const ENSURE_REPORTLAB = `
import subprocess, sys
def _pip_install(pkg):
    for args in [[sys.executable, '-m', 'pip', 'install', '-q', pkg],
                 [sys.executable, '-m', 'pip', 'install', '-q', '--break-system-packages', pkg]]:
        try:
            subprocess.check_call(args)
            return
        except Exception:
            continue
try:
    import reportlab
except ImportError:
    _pip_install('reportlab')
`;

/** Ensure pdfplumber is importable; pip-install silently if missing. */
const ENSURE_PDFPLUMBER = `
import subprocess, sys
def _pip_install(pkg):
    for args in [[sys.executable, '-m', 'pip', 'install', '-q', pkg],
                 [sys.executable, '-m', 'pip', 'install', '-q', '--break-system-packages', pkg]]:
        try:
            subprocess.check_call(args)
            return
        except Exception:
            continue
try:
    import pdfplumber
except ImportError:
    _pip_install('pdfplumber')
`;

/** Create mode: prepend reportlab auto-install, then run the user script. */
async function handleCreate(args: Args, ctx: ToolContext): Promise<string> {
  const script = `${ENSURE_REPORTLAB}\n${args.script!}`;
  const result = await runPython(script, ctx.projectDir, DEFAULT_TIMEOUT_MS);
  return formatPythonResult(result);
}

/** Read mode: resolve the input PDF path, then extract text via pdfplumber. */
async function handleRead(args: Args, ctx: ToolContext): Promise<string> {
  if (!args.path) return "Error: read mode requires `path` to the PDF file.";
  let pdfPath: string;
  try {
    pdfPath = await resolveWithin(ctx.projectDir, args.path);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  // Base64-encode the path to avoid shell-escaping issues.
  const pathB64 = Buffer.from(pdfPath).toString("base64");
  const script = `${ENSURE_PDFPLUMBER}
import base64, pdfplumber
pdf_path = base64.b64decode("${pathB64}").decode("utf-8")
try:
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            if i > 0:
                print("\\f")
            print(text)
except Exception as e:
    print(f"Error reading PDF: {e}", file=sys.stderr)
`;
  const result = await runPython(script, ctx.projectDir, DEFAULT_TIMEOUT_MS);
  return formatPythonResult(result);
}

/** OCR mode: render PDF pages to images via Python (PyMuPDF/fitz), then OCR
 *  each page via Tesseract (pytesseract). All in one Python script. */
async function handleOcr(args: Args, ctx: ToolContext): Promise<string> {
  if (!args.path) return "Error: OCR mode requires `path` to the PDF file.";
  let pdfPath: string;
  try {
    pdfPath = await resolveWithin(ctx.projectDir, args.path);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  const language = args.ocrLanguage ?? "ind";
  const pathB64 = Buffer.from(pdfPath).toString("base64");
  const langB64 = Buffer.from(language).toString("base64");

  const script = `
import subprocess, sys, base64, io

def _pip_install(pkg):
    for args in [[sys.executable, '-m', 'pip', 'install', '-q', pkg],
                 [sys.executable, '-m', 'pip', 'install', '-q', '--break-system-packages', pkg]]:
        try:
            subprocess.check_call(args)
            return
        except Exception:
            continue

# Auto-install dependencies
for pkg, mod in [('PyMuPDF', 'fitz'), ('pytesseract', 'pytesseract'), ('Pillow', 'PIL')]:
    try:
        __import__(mod)
    except ImportError:
        _pip_install(pkg)

import fitz  # PyMuPDF
import pytesseract
from PIL import Image

pdf_path = base64.b64decode("${pathB64}").decode("utf-8")
lang = base64.b64decode("${langB64}").decode("utf-8")

doc = fitz.open(pdf_path)
for i, page in enumerate(doc):
    # Render page to image at 200 DPI for good OCR accuracy
    pix = page.get_pixmap(dpi=200)
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    text = pytesseract.image_to_string(img, lang=lang)
    if i > 0:
        print("\\f")
    print(text)
doc.close()
`;
  const result = await runPython(script, ctx.projectDir, DEFAULT_TIMEOUT_MS);
  return formatPythonResult(result);
}
