import { runPython, type PythonResult } from "./python-runner.js";

/**
 * Local OCR helper backed by the host's Python + Tesseract stack. NOT a tool —
 * it is an internal capability consumed by tools that need to extract text
 * from images (currently `pdf_script` when OCR-ing a scanned PDF; future tools
 * can reuse it). Keeping OCR out of the tool registry avoids ambiguity with
 * `analyze_image` (the remote multimodal path): the model never "chooses" OCR,
 * a tool decides to use it internally based on its own arguments.
 *
 * Pipeline: image file(s) on disk -> python3 + pytesseract -> text per image.
 *
 * Host prerequisites (mirrors the speech tools' convention — the host installs
 * these, and if anything is missing the full Python stderr is returned so the
 * model can explain the failure to the user):
 *   - python3 on PATH
 *   - pip install pytesseract Pillow
 *   - tesseract binary on PATH (apt install tesseract-ocr | brew install tesseract
 *     | choco install tesseract)
 *
 * No API key is required — Tesseract runs entirely locally.
 */

/** Default Tesseract language(s). Indonesian, matching the speech tools'
 * id-ID defaults. Override per-call or via env. */
const DEFAULT_LANGUAGE = "ind";
/** Default wall-clock cap for one OCR run (covers many pages). */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface OcrOptions {
  /** Tesseract language code, e.g. "eng", "ind", or "eng+ind" for multi. */
  language?: string;
  /** Hard wall-clock cap in ms. */
  timeoutMs?: number;
  /** Working directory for the Python process (session project dir). */
  cwd?: string;
}

export interface OcrResult {
  /** Recognized text per input image, in input order. */
  pages: string[];
  /** Raw Python outcome for diagnostics (exit code, stdout, stderr). */
  raw: PythonResult;
  /** True if the Python run itself failed (missing lib, non-zero exit). */
  failed: boolean;
}

/**
 * OCR one or more PNG/JPEG image files via pytesseract. Returns the recognized
 * text per image plus the raw Python result for error reporting.
 *
 * The image paths are passed to Python as base64 to avoid any shell/quote
 * escaping hazards in the generated source (same pattern as the speech tools).
 * Each page's text is emitted on stdout behind a sentinel marker so the caller
 * can split multi-page output reliably even if the text itself contains
 * newlines.
 *
 * This function never throws — on a Python failure (e.g. pytesseract not
 * installed), `failed` is true and the caller surfaces `raw.stderr`.
 */
export async function ocrImagesToText(
  imagePaths: string[],
  opts: OcrOptions = {},
): Promise<OcrResult> {
  const language =
    opts.language ??
    process.env.SIBERFLOW_PDF_OCR_LANGUAGE ??
    DEFAULT_LANGUAGE;
  const timeoutMs =
    opts.timeoutMs ??
    resolveTimeoutFromEnv() ??
    DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd ?? process.cwd();

  if (imagePaths.length === 0) {
    return { pages: [], raw: emptyResult(), failed: false };
  }

  // Each path is base64-encoded into the generated script. The script prints
  // a sentinel-delimited block per image so multi-page output is splittable
  // regardless of newlines inside the recognized text.
  const encodedPaths = JSON.stringify(
    imagePaths.map((p) => Buffer.from(p, "utf8").toString("base64")),
  );
  const langB64 = Buffer.from(language, "utf8").toString("base64");

  const script = `import base64, json, sys
paths = [base64.b64decode(x).decode("utf-8") for x in ${encodedPaths}]
lang = base64.b64decode("${langB64}").decode("utf-8")
try:
    import pytesseract
    from PIL import Image
except ImportError as e:
    sys.stderr.write(
        "Missing Python OCR dependency: " + str(e) + ".\\n"
        "Install with:  pip install pytesseract Pillow\\n"
        "Also install the tesseract binary on the host "
        "(apt install tesseract-ocr | brew install tesseract | choco install tesseract).\\n"
    )
    raise SystemExit(2)
SEP = "\\n@@SIBERFLOW_OCR_PAGE@@\\n"
out = []
for p in paths:
    try:
        text = pytesseract.image_to_string(Image.open(p), lang=lang)
    except Exception as e:
        sys.stderr.write("OCR failed for " + p + ": " + str(e) + "\\n")
        raise SystemExit(3)
    out.append(text or "")
# Sentinel-wrapped so the caller can split pages safely.
print("BEGIN_OCR" + SEP + SEP.join(out) + SEP + "END_OCR")
`;

  const raw = await runPython(script, cwd, timeoutMs);
  const failed = raw.code !== 0;

  let pages: string[] = [];
  if (!failed) {
    pages = parsePages(raw.stdout, imagePaths.length);
  }

  return { pages, raw, failed };
}

/** Split the sentinel-wrapped OCR stdout into per-page text. */
function parsePages(stdout: string, expected: number): string[] {
  const SEP = "\n@@SIBERFLOW_OCR_PAGE@@\n";
  const begin = stdout.indexOf("BEGIN_OCR" + SEP);
  const end = stdout.lastIndexOf(SEP + "END_OCR");
  if (begin === -1 || end === -1 || end <= begin) {
    // Malformed/empty output — return empty array; caller falls back to raw.
    return new Array(expected).fill("");
  }
  const body = stdout.slice(begin + ("BEGIN_OCR" + SEP).length, end);
  const pages = body.split(SEP);
  // Pad/truncate to expected length defensively.
  while (pages.length < expected) pages.push("");
  return pages.slice(0, expected);
}

function emptyResult(): PythonResult {
  return { stdout: "", stderr: "", code: 0, timedOut: false };
}

function resolveTimeoutFromEnv(): number | undefined {
  const raw = process.env.SIBERFLOW_PDF_OCR_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
