import type {
  Agent,
  CreateAgentRequest,
  RuntimeDevice,
  UpdateAgentRequest,
} from "@multica/core/types";

export type AgentFormVisibility = "workspace" | "private";

export interface AgentFormValues {
  name: string;
  description: string;
  instructions: string;
  runtimeId: string;
  model: string;
  visibility: AgentFormVisibility;
}

export function initialAgentFormValues(
  agent: Agent | undefined,
  runtimes: RuntimeDevice[],
): AgentFormValues {
  const runtimeId =
    agent?.runtime_id ||
    runtimes.find((runtime) => runtime.status === "online")?.id ||
    runtimes[0]?.id ||
    "";
  return {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    instructions: agent?.instructions ?? "",
    runtimeId,
    model: agent?.model ?? "",
    visibility: agent?.visibility === "private" ? "private" : "workspace",
  };
}

export function canSubmitAgentForm(values: AgentFormValues): boolean {
  return Boolean(values.name.trim() && values.runtimeId.trim());
}

export function agentFormCreateRequest(values: AgentFormValues): CreateAgentRequest {
  return {
    name: values.name.trim(),
    description: values.description.trim() || undefined,
    instructions: values.instructions.trim() || undefined,
    runtime_id: values.runtimeId.trim(),
    model: values.model.trim() || undefined,
    visibility: values.visibility,
  };
}

export function agentFormUpdateRequest(values: AgentFormValues): UpdateAgentRequest {
  return {
    name: values.name.trim(),
    description: values.description.trim(),
    instructions: values.instructions.trim(),
    runtime_id: values.runtimeId.trim(),
    model: values.model.trim(),
    visibility: values.visibility,
  };
}
