import type { Tool } from "../base.js";

/**
 * web_search — search the web and read page content. Two modes:
 *   - mode: "search"  → run a web search query, return up to 10 results with
 *     titles, URLs, and short highlight snippets. Use this to discover what
 *     pages exist for a topic.
 *   - mode: "content" → fetch the readable text of a specific URL (up to
 *     maxCharacters). Use this after a search to read a result in depth, or for
 *     any URL you already know.
 *
 * Use this for: looking up current information, finding documentation, reading
 * articles/blogs/news, checking release notes, getting content from a URL, or
 * any task where you need fresh data from the web. Prefer this over
 * run_browser for plain read-only web research — it is faster and cheaper.
 */

interface SearchModeArgs {
  mode: "search";
  query: string;
}

interface ContentModeArgs {
  mode: "content";
  url: string;
  maxCharacters: number;
}

const DEFAULT_BASE_URL = "https://api.exa.ai";
/** Fixed result count for search mode (not user-configurable by design). */
const SEARCH_NUM_RESULTS = 10;
/** Default + caps for content mode text length. */
const DEFAULT_MAX_CHARACTERS = 500;
const MAX_MAX_CHARACTERS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 200_000;

interface ExaSearchResult {
  id?: string;
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  highlights?: string[];
}

interface ExaContentResult {
  id?: string;
  title?: string;
  url?: string;
  text?: string;
}

interface ExaContentStatus {
  id: string;
  status: string;
  reason?: string;
}

interface ExaSearchResponse {
  requestId?: string;
  results?: ExaSearchResult[];
}

interface ExaContentResponse {
  requestId?: string;
  results?: ExaContentResult[];
  statuses?: ExaContentStatus[];
}

interface ExaError {
  error?: string;
  message?: string;
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web and read page content via Exa. Mode 'search' + `query`: returns up to 10 results " +
    "(title, url, date, snippets). Mode 'content' + `url`: fetches readable text (up to `maxCharacters`, " +
    "default 500, max 15000). Prefer this over run_browser for read-only research — faster and lighter. " +
    "Requires SIBERFLOW_EXA_API_KEY.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["search", "content"],
        description:
          '"search" = run a query and list results; "content" = fetch full text of one url.',
      },
      query: {
        type: "string",
        description: 'Required when mode is "search". The search query.',
      },
      url: {
        type: "string",
        description:
          'Required when mode is "content". The page URL to read (http or https).',
      },
      maxCharacters: {
        type: "integer",
        description:
          'Only for mode "content". Max characters of page text to return. Default 500, max 15000.',
        minimum: 100,
        maximum: MAX_MAX_CHARACTERS,
      },
    },
    required: ["mode"],
    additionalProperties: false,
  },
  async execute(rawArgs: unknown): Promise<string> {
    const args = parseArgs(rawArgs);

    const apiKey = process.env.SIBERFLOW_EXA_API_KEY;
    if (!apiKey) {
      return "Error: SIBERFLOW_EXA_API_KEY is not set. Configure the web search API key to use web_search.";
    }
    const baseUrl = (process.env.SIBERFLOW_EXA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    if (args.mode === "search") {
      return runSearch(baseUrl, apiKey, args.query);
    }
    return runContent(baseUrl, apiKey, args.url, args.maxCharacters);
  },
};

type ParsedArgs = SearchModeArgs | ContentModeArgs;

function parseArgs(raw: unknown): ParsedArgs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Arguments must be an object.");
  }
  const args = raw as Record<string, unknown>;
  const mode = args.mode;
  if (mode !== "search" && mode !== "content") {
    throw new Error('`mode` must be either "search" or "content".');
  }
  if (mode === "search") {
    const query = args.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new Error('`query` is required and must be a non-empty string when mode is "search".');
    }
    return { mode, query: query.trim() };
  }
  // mode === "content"
  const url = args.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error('`url` is required and must be a non-empty string when mode is "content".');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('`url` must start with http:// or https://');
  }
  let maxCharacters = DEFAULT_MAX_CHARACTERS;
  if (args.maxCharacters !== undefined) {
    const n = args.maxCharacters;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 100) {
      throw new Error("`maxCharacters` must be a number >= 100.");
    }
    maxCharacters = Math.min(Math.floor(n), MAX_MAX_CHARACTERS);
  }
  return { mode, url: url.trim(), maxCharacters };
}

/** POST to the search endpoint and format up to 10 results as a string. */
async function runSearch(baseUrl: string, apiKey: string, query: string): Promise<string> {
  const body = {
    query,
    numResults: SEARCH_NUM_RESULTS,
    type: "auto",
    contents: { highlights: true },
  };
  const json = await postJson<ExaSearchResponse & ExaError>(
    `${baseUrl}/search`,
    apiKey,
    body,
  );
  // Exa returns HTTP 200 with an error field on some validation failures.
  if (json.error || json.message) {
    return `Error: web search failed: ${json.error ?? json.message ?? "unknown error"}`;
  }
  const results = json.results ?? [];
  if (results.length === 0) {
    return `No results found for query: ${query}`;
  }
  const lines: string[] = [`Found ${results.length} result(s) for: ${query}`, ""];
  results.forEach((r, i) => {
    const num = i + 1;
    const title = r.title?.trim() || "(untitled)";
    const url = r.url ?? r.id ?? "(no url)";
    lines.push(`${num}. ${title}`);
    lines.push(`   ${url}`);
    if (r.publishedDate) lines.push(`   published: ${r.publishedDate}`);
    if (r.author) lines.push(`   author: ${r.author}`);
    if (r.highlights?.length) {
      const joined = r.highlights.join(" … ").replace(/\s+/g, " ").trim();
      if (joined) lines.push(`   highlights: ${truncateSnippet(joined, 400)}`);
    }
    lines.push("");
  });
  return truncate(lines.join("\n").trim(), MAX_OUTPUT);
}

/** POST to the contents endpoint and format the page text of one URL. */
async function runContent(
  baseUrl: string,
  apiKey: string,
  url: string,
  maxCharacters: number,
): Promise<string> {
  const body = {
    ids: [url],
    text: { maxCharacters },
  };
  const json = await postJson<ExaContentResponse & ExaError>(
    `${baseUrl}/contents`,
    apiKey,
    body,
  );
  if (json.error || json.message) {
    return `Error: web content fetch failed: ${json.error ?? json.message ?? "unknown error"}`;
  }
  // Surface a non-success status (e.g. the page couldn't be parsed) clearly.
  const status = json.statuses?.find((s) => s.id === url);
  if (status && status.status !== "success") {
    return `Error: could not fetch content for ${url} (status: ${status.status}${status.reason ? ` — ${status.reason}` : ""}).`;
  }
  const result = json.results?.[0];
  if (!result) {
    return `Error: no content returned for ${url}.`;
  }
  const title = result.title?.trim() || "(untitled)";
  const text = (result.text ?? "").trim();
  if (!text) {
    return `Title: ${title}\nURL: ${result.url ?? url}\n\n(no readable text extracted from this page)`;
  }
  const header = `Title: ${title}\nURL: ${result.url ?? url}\n\n`;
  return truncate(header + text, MAX_OUTPUT);
}

/**
 * POST JSON with a hard timeout (AbortController). Without this, a stalled
 * endpoint could hang the turn for minutes. Errors are returned as {error} so
 * callers can format them as tool-result strings (project convention: never
 * throw from execute for network failures).
 */
async function postJson<T>(url: string, apiKey: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as T & ExaError;
    if (!res.ok) {
      // Stitch the HTTP status onto the error so the model sees why it failed.
      const detail = json.error ?? json.message ?? res.statusText;
      return { error: `HTTP ${res.status}: ${detail}` } as T & ExaError;
    }
    return json;
  } catch (err) {
    const aborted = controller.signal.aborted;
    const reason = aborted
      ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : (err as Error).message;
    return { error: reason } as T & ExaError;
  } finally {
    clearTimeout(timer);
  }
}

function truncateSnippet(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}
