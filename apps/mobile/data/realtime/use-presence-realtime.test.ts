// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRunNoticeStore } from "@/data/stores/run-notice-store";
import { usePresenceRealtime } from "./use-presence-realtime";

const { invalidateQueries, subscriptionSetups } = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  subscriptionSetups: [] as ((ws: MockWS, wsId: string) => (() => void)[])[],
}));

type EventHandler = (payload: unknown) => void;

interface MockWS {
  on: ReturnType<typeof vi.fn>;
  onReconnect: ReturnType<typeof vi.fn>;
}

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("@/lib/use-ws-subscriptions", () => ({
  useWSSubscriptions: (
    setup: (ws: MockWS, wsId: string) => (() => void)[],
  ) => {
    subscriptionSetups.push(setup);
  },
}));

describe("usePresenceRealtime", () => {
  beforeEach(() => {
    invalidateQueries.mockReset();
    subscriptionSetups.length = 0;
    useRunNoticeStore.getState().dismissNotice();
  });

  it("refreshes hidden agent liveness on daemon register and reconnect", () => {
    usePresenceRealtime();
    expect(subscriptionSetups).toHaveLength(1);

    const handlers = new Map<string, EventHandler>();
    let reconnect: (() => void) | undefined;
    const ws: MockWS = {
      on: vi.fn((event: string, handler: EventHandler) => {
        handlers.set(event, handler);
        return () => {};
      }),
      onReconnect: vi.fn((handler: () => void) => {
        reconnect = handler;
        return () => {};
      }),
    };

    subscriptionSetups[0](ws, "workspace-1");
    handlers.get("daemon:register")?.({});

    const invalidatedKeys = () =>
      invalidateQueries.mock.calls.map(([query]) => query.queryKey);
    expect(invalidatedKeys()).toEqual(
      expect.arrayContaining([
        ["runtimes", "workspace-1"],
        ["agents", "workspace-1"],
      ]),
    );

    invalidateQueries.mockClear();
    handlers.get("task:failed")?.({});
    expect(invalidatedKeys()).toEqual(
      expect.arrayContaining([
        ["agent-task-snapshot", "workspace-1"],
        ["agents", "workspace-1", "runs"],
      ]),
    );

    invalidateQueries.mockClear();
    reconnect?.();

    expect(invalidatedKeys()).toEqual(
      expect.arrayContaining([
        ["runtimes", "workspace-1"],
        ["agents", "workspace-1"],
        ["agent-task-snapshot", "workspace-1"],
        ["agents", "workspace-1", "runs"],
      ]),
    );
  });

  it("shows a completion notice and refreshes run projections", () => {
    usePresenceRealtime();
    const handlers = new Map<string, EventHandler>();
    const ws: MockWS = {
      on: vi.fn((event: string, handler: EventHandler) => {
        handlers.set(event, handler);
        return () => {};
      }),
      onReconnect: vi.fn(() => () => {}),
    };
    subscriptionSetups[0](ws, "workspace-1");

    handlers.get("task:completed")?.({
      task_id: "task-1",
      agent_id: "agent-1",
      issue_id: "issue-1",
      chat_session_id: "chat-1",
      status: "completed",
    });

    expect(useRunNoticeStore.getState().notice).toEqual({
      taskId: "task-1",
      issueId: "issue-1",
      chatSessionId: "chat-1",
    });
    expect(invalidateQueries.mock.calls.map(([query]) => query.queryKey)).toEqual(
      expect.arrayContaining([
        ["agent-task-snapshot", "workspace-1"],
        ["agents", "workspace-1", "runs"],
      ]),
    );
  });
});
