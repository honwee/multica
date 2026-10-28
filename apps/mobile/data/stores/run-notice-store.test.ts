// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useRunNoticeStore } from "./run-notice-store";

const store = () => useRunNoticeStore.getState();
const firstNotice = { taskId: "task-1", issueId: "issue-1" };

describe("run notice store", () => {
  beforeEach(() => {
    store().dismissNotice();
  });

  it("shows a run completion notice", () => {
    store().showNotice(firstNotice);

    expect(store().notice).toEqual(firstNotice);
  });

  it("deduplicates the current task and replaces it for a different task", () => {
    store().showNotice(firstNotice);
    const current = store().notice;

    store().showNotice({ taskId: "task-1", issueId: "issue-other" });
    expect(store().notice).toBe(current);

    store().showNotice({ taskId: "task-2", issueId: "issue-2" });
    expect(store().notice).toEqual({ taskId: "task-2", issueId: "issue-2" });
  });

  it("allows a task notice again after dismissal", () => {
    store().showNotice(firstNotice);
    store().dismissNotice("task-1");
    expect(store().notice).toBeNull();

    store().showNotice(firstNotice);
    expect(store().notice).toEqual(firstNotice);
  });

  it("does not let a stale dismissal clear a replacement", () => {
    store().showNotice(firstNotice);
    store().showNotice({ taskId: "task-2", issueId: "issue-2" });

    store().dismissNotice("task-1");

    expect(store().notice?.taskId).toBe("task-2");
  });
});
