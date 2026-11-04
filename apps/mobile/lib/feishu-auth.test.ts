// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildFeishuAuthorizationUrl,
  FeishuCallbackError,
  getFeishuTokenFromAuthSession,
  MULTICA_AUTH_CALLBACK_URL,
  parseFeishuCallbackUrl,
  resolveFeishuWebUrl,
} from "./feishu-auth";

describe("getFeishuTokenFromAuthSession", () => {
  it("returns the validated token from a successful system auth session", () => {
    expect(
      getFeishuTokenFromAuthSession({
        type: "success",
        url: "multica://auth/callback?token=feishu-jwt",
      }),
    ).toBe("feishu-jwt");
  });

  it.each(["cancel", "dismiss"])("returns to login without an error on %s", (type) => {
    expect(getFeishuTokenFromAuthSession({ type })).toBeNull();
  });

  it("rejects an interrupted or invalid session result", () => {
    expect(() => getFeishuTokenFromAuthSession({ type: "locked" })).toThrow(
      "Feishu authorization did not complete",
    );
    expect(() => getFeishuTokenFromAuthSession({ type: "success" })).toThrow(
      FeishuCallbackError,
    );
  });
});

describe("resolveFeishuWebUrl", () => {
  it("uses the configured Web origin for the self-hosted deployment", () => {
    expect(
      resolveFeishuWebUrl(
        " https://fde.lumistedu.com/auth/callback?ignored=true ",
        "https://api.example.test",
      ),
    ).toBe("https://fde.lumistedu.com");
  });

  it("falls back to the API origin only when Web URL is unset", () => {
    expect(
      resolveFeishuWebUrl("  ", " https://fde.lumistedu.com/api "),
    ).toBe("https://fde.lumistedu.com");
    expect(resolveFeishuWebUrl(undefined, "http://192.168.1.42:8080")).toBe(
      "http://192.168.1.42:8080",
    );
  });

  it.each([
    ["", undefined],
    ["not a URL", undefined],
    ["javascript:alert(1)", undefined],
    ["https://user:password@example.test", undefined],
    ["not a URL", "https://api.example.test"],
  ])("rejects an unusable origin without switching deployments", (webUrl, apiUrl) => {
    expect(resolveFeishuWebUrl(webUrl, apiUrl)).toBeNull();
  });
});

describe("buildFeishuAuthorizationUrl", () => {
  it("matches the Web Feishu authorization and native handoff contract", () => {
    const authorizationUrl = buildFeishuAuthorizationUrl({
      appId: " cli_fde ",
      webUrl: "https://fde.lumistedu.com",
    });
    const url = new URL(authorizationUrl);

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cli_fde",
      redirect_uri: "https://fde.lumistedu.com/auth/callback",
      response_type: "code",
      state: "provider:feishu,platform:mobile",
    });
    expect(authorizationUrl).not.toContain("secret");
  });

  it("rejects missing public configuration", () => {
    expect(() =>
      buildFeishuAuthorizationUrl({ appId: " ", webUrl: "https://fde.lumistedu.com" }),
    ).toThrow("Feishu login is not configured");
    expect(() =>
      buildFeishuAuthorizationUrl({ appId: "cli_fde", webUrl: "multica://auth/callback" }),
    ).toThrow("Feishu login is not configured");
  });
});

describe("parseFeishuCallbackUrl", () => {
  it("reads an encoded bearer token from the Multica deep link", () => {
    const token = "header.payload.signature-with_symbols";
    const callback = `${MULTICA_AUTH_CALLBACK_URL}?token=${encodeURIComponent(token)}`;

    expect(parseFeishuCallbackUrl(callback)).toBe(token);
  });

  it.each([
    "https://fde.lumistedu.com/auth/callback?token=jwt",
    "multica://auth/callback",
    "multica://auth/callback?token=%20",
    "multica://auth/other?token=jwt",
    "multica://other/callback?token=jwt",
    "not a URL",
  ])("rejects an invalid callback: %s", (callback) => {
    expect(() => parseFeishuCallbackUrl(callback)).toThrow(FeishuCallbackError);
  });
});
