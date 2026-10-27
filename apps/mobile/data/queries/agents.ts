import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "@/data/api";

export const agentKeys = {
  all: (wsId: string | null) => ["agents", wsId] as const,
  runs: (wsId: string | null, agentId: string) =>
    [...agentKeys.all(wsId), "runs", agentId] as const,
};

export const agentDetailOptions = (id: string | null) =>
  queryOptions({
    queryKey: ["agent", id] as const,
    queryFn: ({ signal }) => api.getAgent(id!, { signal }),
    enabled: !!id,
  });

export const agentListOptions = (wsId: string | null) =>
  queryOptions({
    queryKey: agentKeys.all(wsId),
    queryFn: ({ signal }) =>
      api.listAgents({ signal, includeArchived: true }),
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

export const agentRunsOptions = (
  wsId: string | null,
  agentId: string | null,
) =>
  infiniteQueryOptions({
    queryKey: agentKeys.runs(wsId, agentId ?? ""),
    queryFn: ({ signal, pageParam }) =>
      api.listAgentTasksPage(agentId!, {
        before: pageParam ?? undefined,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(wsId && agentId),
  });
