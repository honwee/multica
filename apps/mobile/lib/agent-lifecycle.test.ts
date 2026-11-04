import { describe, expect, it } from "vitest";
import type { Agent } from "@multica/core/types";
import { agentLifecycleAction, buildAgentListItems } from "./agent-list";

const active = {
  id: "active",
  name: "Active",
  model: "",
  owner_id: "owner",
  runtime_id: "runtime",
  runtime_bound: true,
  archived_at: null,
  permission_mode: "public_to",
  invocation_targets: [{ target_type: "workspace", target_id: null }],
} as Agent;
const archived = { ...active, id: "archived", archived_at: "2026-10-27T10:00:00Z" } as Agent;

describe("agent lifecycle", () => {
  it("separates archived agents from the active list", () => {
    const input = {
      agents: [active, archived],
      presenceByAgent: new Map(),
      userId: "owner",
      role: "member" as const,
    };
    expect(buildAgentListItems(input).map((item) => item.agent.id)).toEqual(["active"]);
    expect(
      buildAgentListItems({ ...input, scope: "archived" }).map((item) => item.agent.id),
    ).toEqual(["archived"]);
  });

  it("offers archive and restore only to managers", () => {
    expect(agentLifecycleAction(active, false)).toBeNull();
    expect(agentLifecycleAction(active, true)).toBe("archive");
    expect(agentLifecycleAction(archived, false)).toBeNull();
    expect(agentLifecycleAction(archived, true)).toBe("restore");
  });

  it("does not offer archive for built-in agents", () => {
    expect(agentLifecycleAction({ ...active, system_key: "mika" }, true)).toBeNull();
    expect(agentLifecycleAction({ ...archived, system_key: "mika" }, true)).toBe("restore");
  });
});
