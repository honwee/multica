// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildServerWebSocketUrl,
  DEFAULT_SERVER_URL,
  getBuildServerConfig,
  normalizeServerUrl,
  ServerUrlError,
} from "./server-config";

afterEach(() => vi.unstubAllEnvs());

describe("normalizeServerUrl", () => {
  it.each([
    ["https://fde.lumistedu.com", "https://fde.lumistedu.com"],
    [" https://fde.lumistedu.com/ ", "https://fde.lumistedu.com"],
    ["http://192.168.1.42:8080", "http://192.168.1.42:8080"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each<[string | undefined, ServerUrlError["code"]]>([
    [undefined, "required"],
    ["  ", "required"],
    ["not a URL", "invalid"],
    ["multica://auth/callback", "invalid"],
    ["https://user:password@example.test", "invalid"],
    ["https://example.test/api", "path"],
    ["https://example.test?token=secret", "path"],
    ["https://example.test/#fragment", "path"],
  ])("rejects %s with %s", (input, code) => {
    expect(() => normalizeServerUrl(input)).toThrowError(
      expect.objectContaining<Partial<ServerUrlError>>({ code }),
    );
  });
});

describe("server environment configuration", () => {
  it("keeps the existing self-hosted default when build values are absent", () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "");
    vi.stubEnv("EXPO_PUBLIC_WEB_URL", "");
    expect(getBuildServerConfig()).toEqual({
      apiUrl: DEFAULT_SERVER_URL,
      webUrl: DEFAULT_SERVER_URL,
    });
  });

  it("uses the API origin for OAuth when the Web origin is unset", () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "https://api.example.test/");
    vi.stubEnv("EXPO_PUBLIC_WEB_URL", "");
    expect(getBuildServerConfig()).toEqual({
      apiUrl: "https://api.example.test",
      webUrl: "https://api.example.test",
    });
  });

  it("supports separate API and Web origins", () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "https://api.example.test");
    vi.stubEnv("EXPO_PUBLIC_WEB_URL", "https://app.example.test");
    expect(getBuildServerConfig()).toEqual({
      apiUrl: "https://api.example.test",
      webUrl: "https://app.example.test",
    });
  });

  it("derives secure and local WebSocket endpoints", () => {
    expect(buildServerWebSocketUrl("https://example.test")).toBe(
      "wss://example.test/ws",
    );
    expect(buildServerWebSocketUrl("http://192.168.1.42:8080")).toBe(
      "ws://192.168.1.42:8080/ws",
    );
  });
});
