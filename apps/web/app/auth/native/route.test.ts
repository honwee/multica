import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

function requestWithQuery(query = "code=test-code&state=provider:feishu,platform:mobile"): Request {
  return new Request(`https://multica.test/auth/native?${query}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("native auth handoff", () => {
  it("exchanges the code server-side and returns a no-store 302", async () => {
    vi.stubEnv("REMOTE_API_URL", "http://backend:8080");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "header.payload/with_symbols" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(requestWithQuery());

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "multica://auth/callback?token=header.payload%2Fwith_symbols",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend:8080/auth/feishu",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      code: "test-code",
      redirect_uri: "https://multica.test/auth/callback",
    });
  });

  it("uses the public forwarded origin for the Feishu redirect URI", async () => {
    vi.stubEnv("REMOTE_API_URL", "http://backend:8080");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "native-jwt" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await GET(new Request("http://localhost:3000/auth/native?code=test-code&state=provider:feishu,platform:mobile", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "fde.lumistedu.com",
      },
    }));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      code: "test-code",
      redirect_uri: "https://fde.lumistedu.com/auth/callback",
    });
  });

  it("closes the native session with an error when the exchange fails", async () => {
    vi.stubEnv("REMOTE_API_URL", "http://backend:8080");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid code" }), { status: 400 }),
    ));

    const response = await GET(requestWithQuery());

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "multica://auth/callback?error=login_failed",
    );
  });

  it("does not call the backend without an authorization code", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(requestWithQuery("state=provider:feishu,platform:mobile"));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "multica://auth/callback?error=login_failed",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
