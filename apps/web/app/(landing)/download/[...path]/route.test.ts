import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, HEAD } from "./route";

const IPA_PATH = ["0.1.0", "multica-mobile-0.1.0.ipa"];

describe("download proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams an allowlisted IPA from OSS with download headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("ipa-bytes", {
        status: 200,
        headers: { "Content-Length": "8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("https://fde.lumistedu.com/download/0.1.0/multica-mobile-0.1.0.ipa"), {
      params: Promise.resolve({ path: IPA_PATH }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Length")).toBe("8");
    expect(response.headers.get("Content-Disposition")).toContain("multica-mobile-0.1.0.ipa");
    expect(await response.text()).toBe("ipa-bytes");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://lumist-fde-report.oss-cn-shanghai.aliyuncs.com/downloads/0.1.0/multica-mobile-0.1.0.ipa",
      { method: "GET", cache: "no-store" },
    );
  });

  it("rejects paths outside the allowlist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new Request("https://fde.lumistedu.com/download/private.key"), {
      params: Promise.resolve({ path: ["private.key"] }),
    });
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports HEAD without returning a body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { "Content-Length": "8" } }),
    ));
    const response = await HEAD(new Request("https://fde.lumistedu.com/download/0.1.0/multica-mobile-0.1.0.ipa"), {
      params: Promise.resolve({ path: IPA_PATH }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("8");
    expect(await response.text()).toBe("");
  });
});
