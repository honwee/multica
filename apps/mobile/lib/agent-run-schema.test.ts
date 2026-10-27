import { describe, expect, it } from "vitest";
import { AgentTaskPageSchema } from "@multica/core/api/schemas";

const run = {
  id: "task-1",
  agent_id: "agent-1",
  runtime_id: "runtime-1",
  issue_id: "issue-1",
  status: "failed",
  created_at: "2026-10-27T11:00:00Z",
};

describe("agent run response compatibility", () => {
  it("preserves per-run usage and pagination", () => {
    const parsed = AgentTaskPageSchema.parse({
      tasks: [{
        ...run,
        usage: [{ model: "kimi", input_tokens: 12, output_tokens: 4 }],
      }],
      nextCursor: "cursor-1",
    });
    expect(parsed.nextCursor).toBe("cursor-1");
    expect(parsed.tasks[0].usage?.[0]).toMatchObject({
      model: "kimi",
      input_tokens: 12,
      output_tokens: 4,
      cache_read_tokens: 0,
    });
  });

  it("degrades malformed additive usage without erasing the run", () => {
    const parsed = AgentTaskPageSchema.parse({
      tasks: [{ ...run, usage: "invalid" }],
      nextCursor: null,
    });
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].usage).toBeUndefined();
  });
});
