import { queryOptions } from "@tanstack/react-query";
import { api } from "@/data/api";

export const agentDetailOptions = (id: string | null) =>
  queryOptions({
    queryKey: ["agent", id] as const,
    queryFn: ({ signal }) => api.getAgent(id!, { signal }),
    enabled: !!id,
  });

export const agentListOptions = (wsId: string | null) =>
  queryOptions({
    queryKey: ["agents", wsId] as const,
    queryFn: ({ signal }) => api.listAgents({ signal }),
    enabled: !!wsId,
    // Mirrors Web/Desktop: projected unstable ages offline without an event,
    // while offline recovery is covered by lifecycle events and reconnect.
    refetchInterval: (query) =>
      query.state.data?.some(
        (agent) =>
          !agent.archived_at &&
          (agent.runtime_availability === "online" ||
            agent.runtime_availability === "unstable"),
      )
        ? 30_000
        : false,
  });
