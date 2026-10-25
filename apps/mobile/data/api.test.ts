import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";

// api.ts refuses to load without a base URL; set it before the import runs.
vi.hoisted(() => {
  process.env.EXPO_PUBLIC_API_URL = "https://api.example.test";
});

// The real store pulls in expo-secure-store; the client only needs the slug.
vi.mock("@/data/workspace-store", () => ({ getCurrentSlug: () => null }));

describe("api.deleteComment", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // #8296: servers that keep a deleted comment's replies also route
  // /keep-replies; older servers do not, so a keep-replies delete that reaches
  // one fails instead of deleting the replies too.
  it.each([
    [{ keepReplies: true }, "https://api.example.test/api/comments/comment-1/keep-replies"],
    [{ keepReplies: false }, "https://api.example.test/api/comments/comment-1"],
    [undefined, "https://api.example.test/api/comments/comment-1"],
  ])("with %j sends DELETE %s", async (opts, url) => {
    await api.deleteComment("comment-1", opts);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: "DELETE" }));
  });
});

describe("api authentication compatibility", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads the public Feishu app ID from the deployment config", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ feishu_app_id: "cli_fde" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(api.getConfig()).resolves.toMatchObject({ feishu_app_id: "cli_fde" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/config",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("hides Feishu when its public app ID has an unknown shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ feishu_app_id: 42 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const config = await api.getConfig();
    expect(config.feishu_app_id).toBeUndefined();
    expect(config.allow_signup).toBe(true);
  });

  it("validates the existing email-code response and preserves internal account emails", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "jwt",
          user: { id: "user-1", email: "ou_internal@feishu.invalid" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await api.verifyCode("member@example.test", "123456");

    expect(result.token).toBe("jwt");
    expect(result.user).toMatchObject({
      id: "user-1",
      email: "ou_internal@feishu.invalid",
      avatar_url: null,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      email: "member@example.test",
      code: "123456",
    });
  });

  it("returns a detectable empty login fallback for a malformed success body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "user-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(api.verifyCode("member@example.test", "123456")).resolves.toMatchObject({
      token: "",
      user: { id: "" },
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[api] schema validation failed: verifyCode",
      expect.any(Object),
    );
  });
});
