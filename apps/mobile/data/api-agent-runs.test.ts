import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

vi.hoisted(() => {
  process.env.EXPO_PUBLIC_API_URL = "https://api.example.test";
});
vi.mock("@/data/workspace-store", () => ({ getCurrentSlug: () => "local-ui" }));

describe("api agent run history", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests usage and reads the next cursor from response headers", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Agent-Tasks-Next-Cursor": "next-cursor",
        },
      }),
    );

    await expect(
      api.listAgentTasksPage("agent-1", { limit: 25, before: "old-cursor" }),
    ).resolves.toEqual({ tasks: [], nextCursor: "next-cursor" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.example.test/api/agents/agent-1/tasks?limit=25&include_usage=true&before=old-cursor",
    );
    expect(init.headers["X-Workspace-Slug"]).toBe("local-ui");
  });

  it("returns no cursor when the final page omits the header", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(api.listAgentTasksPage("agent-1")).resolves.toEqual({
      tasks: [],
      nextCursor: null,
    });
  });
});
