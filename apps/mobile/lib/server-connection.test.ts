// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ServerConnectionError,
  testServerConnection,
} from "./server-connection";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("testServerConnection", () => {
  it("checks the public deployment config without sending credentials", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ feishu_app_id: "cli_example" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      testServerConnection(" https://example.test/ "),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/api/config",
      expect.objectContaining({
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.stringify(init)).not.toContain("Authorization");
  });

  it("classifies an unreachable server", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    await expect(testServerConnection("https://example.test")).rejects.toEqual(
      expect.objectContaining<Partial<ServerConnectionError>>({ code: "network" }),
    );
  });

  it("preserves the HTTP status for a readable error", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(testServerConnection("https://example.test")).rejects.toEqual(
      expect.objectContaining<Partial<ServerConnectionError>>({
        code: "http",
        status: 404,
      }),
    );
  });

  it.each([
    ["not JSON", "not JSON"],
    ["a non-object config", JSON.stringify(["not-a-config"])],
  ])("rejects %s instead of treating any 200 response as Multica", async (_name, body) => {
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    await expect(testServerConnection("https://example.test")).rejects.toEqual(
      expect.objectContaining<Partial<ServerConnectionError>>({
        code: "invalid_response",
      }),
    );
  });

  it("times out an unresponsive connection", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
    );

    const result = testServerConnection("https://example.test");
    const assertion = expect(result).rejects.toEqual(
      expect.objectContaining<Partial<ServerConnectionError>>({ code: "timeout" }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});
