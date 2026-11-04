import { queryOptions } from "@tanstack/react-query";
import type { RuntimeModelsResult } from "@multica/core/types";
import { api } from "@/data/api";

// Runtime list — workspace-scoped. Feeds the availability dimension of the
// presence dot via @multica/core/agents/derive-presence (status + last_seen_at).
// Invalidated by daemon:register / sweeper-driven status changes; see
// data/realtime/use-presence-realtime.ts.
export const runtimeListOptions = (wsId: string | null) =>
  queryOptions({
    queryKey: ["runtimes", wsId] as const,
    queryFn: ({ signal }) => api.listRuntimes({ signal }),
    enabled: !!wsId,
  });

export const runtimeModelsKeys = {
  forRuntime: (wsId: string | null, runtimeId: string) =>
    ["runtimes", wsId, "models", runtimeId] as const,
};

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 100_000;
const LIVE_MODELS_STALE_TIME_MS = 5 * 60_000;

export async function resolveRuntimeModels(
  runtimeId: string,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<RuntimeModelsResult> {
  const initial = await api.initiateListModels(runtimeId, options);
  let current = initial;
  const start = Date.now();
  while (current.status === "pending" || current.status === "running") {
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error("model discovery timed out");
    }
    await modelPollDelay(options.signal);
    current = await api.getListModelsResult(runtimeId, initial.id, {
      signal: options.signal,
    });
  }
  if (current.status !== "completed") {
    throw new Error(
      current.error || `model discovery failed (status: ${current.status})`,
    );
  }
  return {
    models: current.models ?? [],
    unavailableModels: current.unavailable_models ?? [],
    supported: current.supported !== false,
    cached: current.cached === true,
    cachedAt: current.cached_at,
  };
}

function modelPollDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("model discovery cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, POLL_INTERVAL_MS);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("model discovery cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const runtimeModelsOptions = (
  wsId: string | null,
  runtimeId: string | null,
  runtimeOnline: boolean,
) =>
  queryOptions({
    queryKey: runtimeModelsKeys.forRuntime(wsId, runtimeId ?? ""),
    queryFn: ({ signal }) => resolveRuntimeModels(runtimeId!, { signal }),
    enabled: Boolean(wsId && runtimeId && runtimeOnline),
    staleTime: (query) =>
      query.state.data?.cached ? 0 : LIVE_MODELS_STALE_TIME_MS,
    gcTime: 30 * 60_000,
    retry: false,
  });
