import { describe, expect, it } from "vitest";
import type { AgentTask } from "@multica/core/types";
import {
  canRetryAgentRun,
  isActiveAgentRun,
  runUsageTotals,
  splitAgentRuns,
} from "./agent-run";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "failed",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: "2026-10-27T12:00:00Z",
    result: null,
    error: null,
    created_at: "2026-10-27T11:00:00Z",
    ...overrides,
  };
}

describe("agent run state", () => {
  it("treats deferred and directory waits as active work", () => {
    expect(isActiveAgentRun(task({ status: "deferred" }))).toBe(true);
    expect(isActiveAgentRun(task({ status: "waiting_local_directory" }))).toBe(true);
    expect(isActiveAgentRun(task({ status: "completed" }))).toBe(false);
  });

  it("blocks duplicate retry while the same issue and agent have active work", () => {
    const failed = task();
    const active = task({ id: "active", status: "queued", completed_at: null });
    expect(canRetryAgentRun(failed, [failed, active])).toBe(false);
    expect(
      canRetryAgentRun(failed, [failed, { ...active, agent_id: "another-agent" }]),
    ).toBe(true);
    expect(
      canRetryAgentRun(failed, [failed, { ...active, status: "completed" }]),
    ).toBe(true);
  });

  it("does not offer issue retry for chat runs or successful runs", () => {
    expect(canRetryAgentRun(task({ issue_id: "", kind: "chat" }), [])).toBe(false);
    expect(canRetryAgentRun(task({ status: "completed" }), [])).toBe(false);
  });

  it("separates active and past runs without losing terminal history", () => {
    const failed = task();
    const running = task({ id: "running", status: "running", completed_at: null });
    expect(splitAgentRuns([failed, running])).toEqual({
      active: [running],
      past: [failed],
    });
  });

  it("distinguishes missing usage from a real zero", () => {
    expect(runUsageTotals(undefined)).toEqual({ input: 0, output: 0, known: false });
    expect(runUsageTotals([])).toEqual({ input: 0, output: 0, known: false });
    expect(
      runUsageTotals([
        { model: "kimi", input_tokens: 10, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0 },
        { model: "kimi", input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 },
      ]),
    ).toEqual({ input: 15, output: 5, known: true });
  });
});
