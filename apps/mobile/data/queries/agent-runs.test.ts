import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentListOptions, agentRunsOptions } from "./agents";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentTasksPage: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock("@/data/api", () => ({ api: mocks }));

beforeEach(() => {
  mocks.listAgents.mockReset();
  mocks.listAgentTasksPage.mockReset();
});

describe("agent queries", () => {
  it("loads archived agents so the lifecycle filter can show them", async () => {
    mocks.listAgents.mockResolvedValue([]);
    await agentListOptions("ws-1").queryFn!({ signal: undefined } as never);
    expect(mocks.listAgents).toHaveBeenCalledWith({
      signal: undefined,
      includeArchived: true,
    });
  });

  it("passes the previous cursor and query abort signal to run history", async () => {
    mocks.listAgentTasksPage.mockResolvedValue({ tasks: [], nextCursor: null });
    const controller = new AbortController();
    await agentRunsOptions("ws-1", "agent-1").queryFn!({
      signal: controller.signal,
      pageParam: "cursor-1",
    } as never);
    expect(mocks.listAgentTasksPage).toHaveBeenCalledWith("agent-1", {
      before: "cursor-1",
      signal: controller.signal,
    });
  });
});
