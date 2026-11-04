/**
 * Presence realtime — Layer 3 of the realtime stack. Listing-level (always
 * on while the user is inside a workspace).
 *
 * Invalidates the queries that back presence and run management:
 *   - runtimeListOptions      ← daemon:register, runtime sweeper transitions
 *   - agentListOptions        ← agent:status / created / archived / restored
 *   - agentTaskSnapshotOptions and agentRunsOptions
 *                            ← task:queued / dispatch / completed / failed /
 *                              cancelled
 *
 * Deliberately NOT subscribed (cellular-data rule, apps/mobile/CLAUDE.md):
 *   - daemon:heartbeat — every 15s × in-online runtime; web also skips it
 *     (packages/core/realtime/use-realtime-sync.ts:147). An invalidate per
 *     heartbeat would refetch agents+runtimes+snapshot 4× a minute per
 *     online runtime — guaranteed to wedge the user on cellular.
 *   - task:progress / task:message — fire many times per active task. The
 *     presence cache only needs lifecycle transitions, not per-step updates.
 *
 * Reconnect: re-invalidate runtimes + agents + task projections after missed events.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRunNoticeStore } from "@/data/stores/run-notice-store";
import { useWSSubscriptions } from "@/lib/use-ws-subscriptions";

export function usePresenceRealtime() {
  const queryClient = useQueryClient();

  useWSSubscriptions(
    (ws, wsId) => {
      const runtimesKey = ["runtimes", wsId];
      const agentsKey = ["agents", wsId];
      const snapshotKey = ["agent-task-snapshot", wsId];
      const runsKey = ["agents", wsId, "runs"];

      const invalidateRuntimes = () =>
        queryClient.invalidateQueries({ queryKey: runtimesKey });
      const invalidateAgents = () =>
        queryClient.invalidateQueries({ queryKey: agentsKey });
      const invalidateSnapshot = () =>
        queryClient.invalidateQueries({ queryKey: snapshotKey });
      const invalidateTaskProjections = () => {
        invalidateSnapshot();
        queryClient.invalidateQueries({ queryKey: runsKey });
      };

      return [
        // Daemon lifecycle; heartbeats deliberately omitted.
        ws.on("daemon:register", () => {
          invalidateRuntimes();
          invalidateAgents();
        }),

        // Agent identity churn — visible in pickers / chat header straight
        // away, so invalidate the cached list.
        ws.on("agent:status", invalidateAgents),
        ws.on("agent:created", invalidateAgents),
        ws.on("agent:archived", invalidateAgents),
        ws.on("agent:restored", invalidateAgents),

        // Task lifecycle — drives presence and the run-history projection.
        // progress / message intentionally absent.
        ws.on("task:queued", invalidateTaskProjections),
        ws.on("task:dispatch", invalidateTaskProjections),
        ws.on("task:completed", (payload) => {
          invalidateTaskProjections();
          useRunNoticeStore.getState().showNotice({
            taskId: payload.task_id,
            issueId: payload.issue_id,
            chatSessionId: payload.chat_session_id,
          });
        }),
        ws.on("task:failed", invalidateTaskProjections),
        ws.on("task:cancelled", invalidateTaskProjections),

        // Recover all presence inputs after missed sweeper transitions.
        ws.onReconnect(() => {
          invalidateRuntimes();
          invalidateAgents();
          invalidateTaskProjections();
        }),
      ];
    },
    [queryClient],
  );
}
