export const DEFAULT_SERVER_URL = "https://fde.lumistedu.com";

export interface ServerConfig {
  apiUrl: string;
  webUrl: string;
}

export type ServerUrlErrorCode = "required" | "invalid" | "path";

export class ServerUrlError extends Error {
  constructor(readonly code: ServerUrlErrorCode) {
    super(code === "required" ? "Server URL is required" : "Invalid server URL");
    this.name = "ServerUrlError";
  }
}

export function normalizeServerUrl(input: string | null | undefined): string {
  const value = input?.trim() ?? "";
  if (!value) throw new ServerUrlError("required");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServerUrlError("invalid");
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new ServerUrlError("invalid");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new ServerUrlError("path");
  }
  return url.origin;
}

export function getBuildServerConfig(): ServerConfig {
  const apiUrl = normalizeServerUrl(
    process.env.EXPO_PUBLIC_API_URL || DEFAULT_SERVER_URL,
  );
  return {
    apiUrl,
    webUrl: normalizeServerUrl(process.env.EXPO_PUBLIC_WEB_URL || apiUrl),
  };
}

export function normalizeServerConfig(config: ServerConfig): ServerConfig {
  return {
    apiUrl: normalizeServerUrl(config.apiUrl),
    webUrl: normalizeServerUrl(config.webUrl),
  };
}

export function serverConfigsEqual(
  left: ServerConfig,
  right: ServerConfig,
): boolean {
  return left.apiUrl === right.apiUrl && left.webUrl === right.webUrl;
}

export function buildServerWebSocketUrl(apiUrl: string): string {
  const url = new URL("/ws", normalizeServerUrl(apiUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
