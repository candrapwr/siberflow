/**
 * Image generation/editing provider adapters for the `image_gen` tool.
 *
 * Each provider implements a uniform interface ({@link ImageGenProvider}) that
 * the tool calls; the adapter handles provider-specific request shapes, auth,
 * and response parsing. All providers return a raw image {@link Buffer} plus a
 * format hint so the tool can pick the right file extension.
 *
 * Providers: openai, deepinfra (OpenAI-compatible endpoint), novita (Seedream),
 * qwen (Tongyi Wanxiang, async task), grok (FLUX-based). grok has no public
 * edit endpoint.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/** Request for a generation call. */
export interface ImageGenRequest {
  prompt: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  size?: string;
}

/** Request for an edit call (adds the source image path). */
export interface ImageEditRequest extends ImageGenRequest {
  imagePath: string;
}

/** Uniform result from every provider. */
export interface ImageGenResult {
  buffer: Buffer;
  format: string;
}

/** Uniform provider interface the tool depends on. */
export interface ImageGenProvider {
  name: string;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
  edit?(req: ImageEditRequest): Promise<ImageGenResult>;
}

/** Hard request timeout — image generation can be slow (up to ~3 min). */
const REQUEST_TIMEOUT_MS = 180_000;
/** Qwen async task polling interval and max attempts. */
const QWEN_POLL_INTERVAL_MS = 3_000;
const QWEN_MAX_POLLS = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/** fetch with an AbortController timeout so a stalled request can't hang. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Read a non-OK response body as text, preferring the API's error message. */
async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text.trim()) return res.statusText;
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const msg = typeof json.error === "object" ? json.error?.message : json.error;
    return msg ?? json.message ?? text.slice(0, 1000);
  } catch {
    return text.slice(0, 1000);
  }
}

/** Download a URL into a Buffer, guessing the format from content-type. */
async function downloadImage(url: string): Promise<ImageGenResult> {
  const res = await fetchWithTimeout(url, {}, REQUEST_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`Failed to download generated image: HTTP ${res.status}: ${await readError(res)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const format = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : "png";
  return { buffer, format };
}

/** Decode an OpenAI-style response: either a URL or a base64 b64_json field. */
async function fromOpenAiData(item: { url?: string; b64_json?: string }): Promise<ImageGenResult> {
  if (item.url) return downloadImage(item.url);
  if (item.b64_json) return { buffer: Buffer.from(item.b64_json, "base64"), format: "png" };
  throw new Error("Provider returned no image url or b64_json.");
}

function authHeader(apiKey: string, scheme: "Bearer" | "Key" = "Bearer"): string {
  return `${scheme} ${apiKey}`;
}

/** Strip trailing slashes from a base URL. */
function cleanBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Guess the image MIME type from a file path's extension. OpenAI's edits
 * endpoint rejects files sent as the default `application/octet-stream` Blob
 * type — it requires an explicit `image/jpeg`, `image/png`, or `image/webp`.
 */
function mimeFor(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
    case "gif":
    case "bmp":
    default:
      return "image/png";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: openai  (gpt-image)
// ─────────────────────────────────────────────────────────────────────────────

export const openaiProvider: ImageGenProvider = {
  name: "openai",
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const url = `${cleanBaseUrl(req.baseUrl)}/images/generations`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { authorization: authHeader(req.apiKey), "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        n: 1,
        ...(req.size ? { size: req.size } : {}),
      }),
    });
    if (!res.ok) throw new Error(`OpenAI images/generations HTTP ${res.status}: ${await readError(res)}`);
    const json = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
    if (!json.data?.[0]) throw new Error("OpenAI returned no image data.");
    return fromOpenAiData(json.data[0]);
  },
  async edit(req: ImageEditRequest): Promise<ImageGenResult> {
    const url = `${cleanBaseUrl(req.baseUrl)}/images/edits`;
    const data = await readFile(req.imagePath);
    const form = new FormData();
    form.set("model", req.model);
    form.set("prompt", req.prompt);
    form.set("image", new Blob([new Uint8Array(data)], { type: mimeFor(req.imagePath) }), basename(req.imagePath));
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { authorization: authHeader(req.apiKey) },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI images/edits HTTP ${res.status}: ${await readError(res)}`);
    const json = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
    if (!json.data?.[0]) throw new Error("OpenAI edit returned no image data.");
    return fromOpenAiData(json.data[0]);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Provider: deepinfra  (OpenAI-compatible endpoint at /v1/openai/images/*)
// Same request/response shape as OpenAI, different base path.
// ─────────────────────────────────────────────────────────────────────────────

export const deepinfraProvider: ImageGenProvider = {
  name: "deepinfra",
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const url = `${cleanBaseUrl(req.baseUrl)}/openai/images/generations`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { authorization: authHeader(req.apiKey), "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        ...(req.size ? { size: req.size } : {}),
      }),
    });
    if (!res.ok) throw new Error(`DeepInfra images/generations HTTP ${res.status}: ${await readError(res)}`);
    const json = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
    if (!json.data?.[0]) throw new Error("DeepInfra returned no image data.");
    return fromOpenAiData(json.data[0]);
  },
  async edit(req: ImageEditRequest): Promise<ImageGenResult> {
    const url = `${cleanBaseUrl(req.baseUrl)}/openai/images/edits`;
    const data = await readFile(req.imagePath);
    const form = new FormData();
    form.set("model", req.model);
    form.set("prompt", req.prompt);
    form.set("image", new Blob([new Uint8Array(data)], { type: mimeFor(req.imagePath) }), basename(req.imagePath));
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { authorization: authHeader(req.apiKey) },
      body: form,
    });
    if (!res.ok) throw new Error(`DeepInfra images/edits HTTP ${res.status}: ${await readError(res)}`);
    const json = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
    if (!json.data?.[0]) throw new Error("DeepInfra edit returned no image data.");
    return fromOpenAiData(json.data[0]);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Provider: novita  (Seedream — /v3/seedream-5.0-lite)
// JSON body; edit sends the source image as base64 in the payload.
// ─────────────────────────────────────────────────────────────────────────────

interface NovitaResponse {
  images?: { image_url?: string; image_base64?: string }[];
  image_base64?: string;
  error?: string;
}

export const novitaProvider: ImageGenProvider = {
  name: "novita",
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const url = `${cleanBaseUrl(req.baseUrl)}/v3/${req.model}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { authorization: authHeader(req.apiKey), "content-type": "application/json" },
      body: JSON.stringify({ prompt: req.prompt, watermark: false }),
    });
    if (!res.ok) throw new Error(`Novita HTTP ${res.status}: ${await readError(res)}`);
    const json = (await res.json()) as NovitaResponse;
    const img = json.images?.[0];
    if (img?.image_url) return downloadImage(img.image_url);
    if (img?.image_base64 || json.image_base64) {
      return { buffer: Buffer.from(img?.image_base64 ?? json.image_base64 ?? "", "base64"), format: "png" };
    }
    throw new Error(`Novita returned no image.${json.error ? ` ${json.error}` : ""}`);
  },
  async edit(req: ImageEditRequest): Promise<ImageGenResult> {
    const url = `${cleanBaseUrl(req.baseUrl)}/v3/${req.model}`;
    const imageData = await readFile(req.imagePath);
    const base64 = imageData.toString("base64");
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { authorization: authHeader(req.apiKey), "content-type": "application/json" },
      body: JSON.stringify({ prompt: req.prompt, image: base64, watermark: false }),
    });
    if (!res.ok) throw new Error(`Novita edit HTTP ${res.status}: ${await readError(res)}`);
    const json = (await res.json()) as NovitaResponse;
    const img = json.images?.[0];
    if (img?.image_url) return downloadImage(img.image_url);
    if (img?.image_base64 || json.image_base64) {
      return { buffer: Buffer.from(img?.image_base64 ?? json.image_base64 ?? "", "base64"), format: "png" };
    }
    throw new Error(`Novita edit returned no image.${json.error ? ` ${json.error}` : ""}`);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Provider: qwen  (Tongyi Wanxiang — async task synthesis)
// POST creates a task → poll GET until SUCCEEDED → download result URL.
// ─────────────────────────────────────────────────────────────────────────────

interface QwenTaskResponse {
  output?: { task_id?: string; task_status?: string };
  message?: string;
}

interface QwenResultResponse {
  output?: {
    task_status?: string;
    results?: { url?: string }[];
  };
  message?: string;
}

export const qwenProvider: ImageGenProvider = {
  name: "qwen",
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    return qwenSynthesis(req, false);
  },
  async edit(req: ImageEditRequest): Promise<ImageGenResult> {
    // img2img: Qwen accepts the source image via the same synthesis endpoint
    // with an extra `image` (URL or base64) parameter. We pass the local file
    // as base64.
    return qwenSynthesis(req, true, req.imagePath);
  },
};

async function qwenSynthesis(
  req: ImageGenRequest,
  isEdit: boolean,
  imagePath?: string,
): Promise<ImageGenResult> {
  const base = cleanBaseUrl(req.baseUrl);
  const url = `${base}/api/v1/services/aigc/text2image/image-synthesis`;
  const headers: Record<string, string> = {
    authorization: authHeader(req.apiKey),
    "content-type": "application/json",
  };
  const input: Record<string, unknown> = { prompt: req.prompt };
  if (isEdit && imagePath) {
    const data = await readFile(imagePath);
    input.image = data.toString("base64");
  }
  const body: Record<string, unknown> = {
    model: req.model,
    input,
    parameters: { size: req.size?.replace("x", "*") ?? "1024*1024", n: 1 },
  };
  const res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Qwen synthesis HTTP ${res.status}: ${await readError(res)}`);
  const task = (await res.json()) as QwenTaskResponse;
  const taskId = task.output?.task_id;
  if (!taskId) throw new Error(`Qwen returned no task_id.${task.message ? ` ${task.message}` : ""}`);

  // Poll the task until it completes.
  const taskUrl = `${base}/api/v1/tasks/${taskId}`;
  for (let i = 0; i < QWEN_MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, QWEN_POLL_INTERVAL_MS));
    const pollRes = await fetchWithTimeout(taskUrl, { headers: { authorization: authHeader(req.apiKey) } });
    if (!pollRes.ok) continue;
    const poll = (await pollRes.json()) as QwenResultResponse;
    const status = poll.output?.task_status;
    if (status === "SUCCEEDED") {
      const imgUrl = poll.output?.results?.[0]?.url;
      if (!imgUrl) throw new Error("Qwen task succeeded but returned no image URL.");
      return downloadImage(imgUrl);
    }
    if (status === "FAILED") throw new Error(`Qwen task failed.${poll.message ? ` ${poll.message}` : ""}`);
    // PENDING / RUNNING → keep polling
  }
  throw new Error(`Qwen task ${taskId} timed out after ${QWEN_MAX_POLLS} polls.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: grok  (xAI — FLUX-based, /v1/images/generations, OpenAI-like)
// Generation only; no public edit endpoint.
// ─────────────────────────────────────────────────────────────────────────────

export const grokProvider: ImageGenProvider = {
  name: "grok",
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const url = `${cleanBaseUrl(req.baseUrl)}/images/generations`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { authorization: authHeader(req.apiKey), "content-type": "application/json" },
      body: JSON.stringify({ model: req.model, prompt: req.prompt, n: 1 }),
    });
    if (!res.ok) throw new Error(`Grok images/generations HTTP ${res.status}: ${await readError(res)}`);
    const json = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
    if (!json.data?.[0]) throw new Error("Grok returned no image data.");
    return fromOpenAiData(json.data[0]);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

/** Map of provider name → adapter. The tool looks up by env-configured name. */
export const IMAGE_GEN_PROVIDERS: Record<string, ImageGenProvider> = {
  openai: openaiProvider,
  deepinfra: deepinfraProvider,
  novita: novitaProvider,
  qwen: qwenProvider,
  grok: grokProvider,
};

/** Default base URL + model per provider (used when env doesn't override). */
export const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-image-1" },
  deepinfra: { baseUrl: "https://api.deepinfra.com/v1", model: "black-forest-labs/FLUX-1-schnell" },
  novita: { baseUrl: "https://api.novita.ai", model: "seedream-5.0-lite" },
  qwen: { baseUrl: "https://dashscope.aliyuncs.com", model: "wanx2.1-turbo" },
  grok: { baseUrl: "https://api.x.ai/v1", model: "grok-2-image" },
};
