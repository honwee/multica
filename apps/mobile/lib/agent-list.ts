import {
  effectiveAccessScope,
  type AccessScope,
  type AgentPresenceDetail,
} from "@multica/core/agents";
import { canAssignAgentToIssue } from "@multica/core/permissions";
import type { Agent, MemberRole } from "@multica/core/types";
import { isAgentRuntimeBound } from "@/lib/is-agent-runtime-bound";

export type AgentDisabledReason = "permission" | "runtime" | null;

export interface AgentListItem {
  agent: Agent;
  model: string;
  accessScope: AccessScope;
  presence: AgentPresenceDetail | null;
  runtimeBound: boolean;
  disabledReason: AgentDisabledReason;
}

export function buildAgentListItems({
  agents,
  presenceByAgent,
  userId,
  role,
}: {
  agents: readonly Agent[];
  presenceByAgent: ReadonlyMap<string, AgentPresenceDetail>;
  userId: string | null;
  role: MemberRole | null;
}): AgentListItem[] {
  return agents
    .filter((agent) => !agent.archived_at)
    .map((agent) => {
      const invocation = canAssignAgentToIssue(agent, { userId, role });
      const runtimeBound = isAgentRuntimeBound(agent);

      return {
        agent,
        model: agent.model.trim(),
        accessScope: effectiveAccessScope(
          agent.permission_mode,
          agent.invocation_targets,
        ),
        presence: presenceByAgent.get(agent.id) ?? null,
        runtimeBound,
        disabledReason: !invocation.allowed
          ? "permission"
          : !runtimeBound
            ? "runtime"
            : null,
      };
    });
}
