const DEFAULT_USER_AGENT = "Siberflow/0.1";
const DEFAULT_CLIENT_NAME = "siberflow";
const DEFAULT_CLIENT_VERSION = "0.1";
const DEFAULT_APP_NAME = "siberflow";
const BLOCKED_HEADER_NAMES = new Set(["authorization", "content-type"]);

export function providerHeaders(
  customHeaders: Record<string, string> | undefined,
  contentType = "application/json",
): Record<string, string> {
  return {
    "Content-Type": contentType,
    "User-Agent": customHeaders?.["User-Agent"] ?? DEFAULT_USER_AGENT,
    "X-Client-Name": customHeaders?.["X-Client-Name"] ?? DEFAULT_CLIENT_NAME,
    "X-Client-Version":
      customHeaders?.["X-Client-Version"] ?? DEFAULT_CLIENT_VERSION,
    "X-App-Name": customHeaders?.["X-App-Name"] ?? DEFAULT_APP_NAME,
    ...customHeaders,
  };
}

export function parseProviderHeadersEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const userAgent = env.SIBERFLOW_PROVIDER_USER_AGENT?.trim();
  if (userAgent) headers["User-Agent"] = userAgent;
  const clientName = env.SIBERFLOW_PROVIDER_CLIENT_NAME?.trim();
  if (clientName) headers["X-Client-Name"] = clientName;
  const clientVersion = env.SIBERFLOW_PROVIDER_CLIENT_VERSION?.trim();
  if (clientVersion) headers["X-Client-Version"] = clientVersion;
  const appName = env.SIBERFLOW_PROVIDER_APP_NAME?.trim();
  if (appName) headers["X-App-Name"] = appName;

  const raw = env.SIBERFLOW_PROVIDER_HEADERS?.trim();
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("SIBERFLOW_PROVIDER_HEADERS must be a JSON object.");
    }
    for (const [name, value] of Object.entries(parsed)) {
      const key = name.trim();
      if (!key) continue;
      if (BLOCKED_HEADER_NAMES.has(key.toLowerCase())) {
        throw new Error(
          `SIBERFLOW_PROVIDER_HEADERS may not override ${key}. Use the dedicated API key/base URL settings instead.`,
        );
      }
      if (typeof value !== "string") {
        throw new Error(`SIBERFLOW_PROVIDER_HEADERS.${key} must be a string.`);
      }
      headers[key] = value;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}
