import { describe, expect, it } from "vitest";
import type { AgentPresenceDetail } from "@multica/core/agents";
import type { Agent } from "@multica/core/types";
import { buildAgentListItems } from "./agent-list";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "Research agent",
    model: "K3.1 Pro",
    owner_id: "owner-1",
    runtime_id: "runtime-1",
    runtime_bound: true,
    archived_at: null,
    permission_mode: "public_to",
    invocation_targets: [{ target_type: "workspace", target_id: null }],
    ...overrides,
  } as Agent;
}

function makePresence(
  availability: AgentPresenceDetail["availability"],
): AgentPresenceDetail {
  return {
    availability,
    workload: "idle",
    runningCount: 0,
    queuedCount: 0,
    capacity: 1,
  };
}

describe("buildAgentListItems", () => {
  it("allows workspace agents and preserves full model names and presence", () => {
    const agent = makeAgent();
    const presence = makePresence("online");

    const [item] = buildAgentListItems({
      agents: [agent],
      presenceByAgent: new Map([[agent.id, presence]]),
      userId: "user-1",
      role: "member",
    });

    expect(item.model).toBe("K3.1 Pro");
    expect(item.accessScope).toBe("workspace");
    expect(item.presence).toBe(presence);
    expect(item.disabledReason).toBeNull();
  });

  it("does not treat an offline runtime as a permission failure", () => {
    const agent = makeAgent();

    const [item] = buildAgentListItems({
      agents: [agent],
      presenceByAgent: new Map([[agent.id, makePresence("offline")]]),
      userId: "user-1",
      role: "member",
    });

    expect(item.presence?.availability).toBe("offline");
    expect(item.disabledReason).toBeNull();
  });

  it("keeps private agents visible but disables them for non-owners, including admins", () => {
    const agent = makeAgent({
      permission_mode: "private",
      invocation_targets: [],
    });

    const [item] = buildAgentListItems({
      agents: [agent],
      presenceByAgent: new Map(),
      userId: "admin-1",
      role: "admin",
    });

    expect(item.accessScope).toBe("owner-only");
    expect(item.disabledReason).toBe("permission");
  });

  it("keeps agents without a bound runtime visible but disabled", () => {
    const agent = makeAgent({
      owner_id: "user-1",
      permission_mode: "private",
      invocation_targets: [],
      runtime_id: "",
      runtime_bound: false,
    });

    const [item] = buildAgentListItems({
      agents: [agent],
      presenceByAgent: new Map(),
      userId: "user-1",
      role: "member",
    });

    expect(item.runtimeBound).toBe(false);
    expect(item.disabledReason).toBe("runtime");
  });

  it("supports member-targeted access and omits archived agents", () => {
    const targeted = makeAgent({
      id: "targeted",
      invocation_targets: [{ target_type: "member", target_id: "user-1" }],
    });
    const archived = makeAgent({
      id: "archived",
      archived_at: "2026-10-01T00:00:00Z",
    });

    const items = buildAgentListItems({
      agents: [targeted, archived],
      presenceByAgent: new Map(),
      userId: "user-1",
      role: "member",
    });

    expect(items).toHaveLength(1);
    expect(items[0].agent.id).toBe("targeted");
    expect(items[0].accessScope).toBe("specific-people");
    expect(items[0].disabledReason).toBeNull();
  });
});
