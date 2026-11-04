import { describe, expect, it, vi } from "vitest";
import { shouldPersistQuery, shouldPersistQueryKey } from "./query-persistence";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

function query(queryKey: readonly unknown[], data: unknown, status = "success") {
  return { queryKey, state: { status, data } };
}

describe("mobile query persistence", () => {
  it("persists only offline-readable workspaces, issues, and chat history", () => {
    expect(shouldPersistQueryKey(["workspaces"])).toBe(true);
    expect(shouldPersistQueryKey(["issues", "ws-1", "list"])).toBe(true);
    expect(shouldPersistQueryKey(["issues", "ws-1", "detail", "issue-1"])).toBe(true);
    expect(shouldPersistQueryKey(["issues", "ws-1", "timeline", "issue-1"])).toBe(true);
    expect(shouldPersistQueryKey(["chat", "ws-1", "sessions"])).toBe(true);
    expect(shouldPersistQueryKey(["chat", "messages", "session-1"])).toBe(true);
    expect(shouldPersistQueryKey(["chat", "pending-task", "session-1"])).toBe(false);
    expect(shouldPersistQueryKey(["agent-task-snapshot", "ws-1"])).toBe(false);
    expect(shouldPersistQueryKey(["issues", "ws-1", "active-tasks", "issue-1"])).toBe(false);
  });

  it("excludes failed and optimistic data", () => {
    expect(query(["issues", "ws-1", "timeline", "issue-1"], [])).toSatisfy(
      (value) => shouldPersistQuery(value),
    );
    expect(
      shouldPersistQuery(query(["issues", "ws-1", "list"], [], "error")),
    ).toBe(false);
    expect(
      shouldPersistQuery(
        query(["issues", "ws-1", "timeline", "issue-1"], [
          { id: "optimistic-comment-1" },
        ]),
      ),
    ).toBe(false);
  });
});
