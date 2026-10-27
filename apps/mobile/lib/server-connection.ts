import { AppConfigSchema } from "@multica/core/api/schemas";

import { normalizeServerUrl } from "./server-config";

const CONNECTION_TIMEOUT_MS = 10_000;

export type ServerConnectionErrorCode =
  | "timeout"
  | "network"
  | "http"
  | "invalid_response";

export class ServerConnectionError extends Error {
  constructor(
    readonly code: ServerConnectionErrorCode,
    readonly status?: number,
  ) {
    super(status ? `Server returned HTTP ${status}` : `Connection failed: ${code}`);
    this.name = "ServerConnectionError";
  }
}

export async function testServerConnection(apiUrl: string): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CONNECTION_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${normalizeServerUrl(apiUrl)}/api/config`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    throw new ServerConnectionError(timedOut ? "timeout" : "network");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new ServerConnectionError("http", response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ServerConnectionError("invalid_response");
  }
  if (!AppConfigSchema.safeParse(body).success) {
    throw new ServerConnectionError("invalid_response");
  }
}
