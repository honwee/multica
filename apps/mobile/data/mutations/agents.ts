import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentTask } from "@multica/core/types";
import { api } from "@/data/api";
import { agentKeys } from "@/data/queries/agents";
import { issueKeys } from "@/data/queries/issues";
import { useWorkspaceStore } from "@/data/workspace-store";

function invalidateRunProjections(
  qc: ReturnType<typeof useQueryClient>,
  wsId: string | null,
  agentId: string,
  issueId?: string,
) {
  void qc.invalidateQueries({ queryKey: agentKeys.runs(wsId, agentId) });
  void qc.invalidateQueries({ queryKey: ["agent-task-snapshot", wsId] });
  if (issueId) {
    void qc.invalidateQueries({ queryKey: issueKeys.activeTasks(wsId, issueId) });
    void qc.invalidateQueries({ queryKey: issueKeys.tasks(wsId, issueId) });
  }
}

export function useCancelAgentRun(agentId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceStore((state) => state.currentWorkspaceId);
  return useMutation({
    mutationFn: (task: AgentTask) => api.cancelTaskById(task.id),
    onSettled: (_data, _error, task) => {
      invalidateRunProjections(qc, wsId, agentId, task.issue_id);
    },
  });
}

export function useRetryAgentRun(agentId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceStore((state) => state.currentWorkspaceId);
  return useMutation({
    mutationFn: (task: AgentTask) => api.rerunIssue(task.issue_id, task.id),
    onSettled: (_data, _error, task) => {
      invalidateRunProjections(qc, wsId, agentId, task.issue_id);
    },
  });
}

export function useAgentLifecycleMutation(agentId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceStore((state) => state.currentWorkspaceId);
  return useMutation({
    mutationFn: (action: "archive" | "restore") =>
      action === "archive" ? api.archiveAgent(agentId) : api.restoreAgent(agentId),
    onSuccess: (agent) => {
      if (agent.id) qc.setQueryData(["agent", agent.id], agent);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.all(wsId) });
      void qc.invalidateQueries({ queryKey: ["agent", agentId] });
      void qc.invalidateQueries({ queryKey: agentKeys.runs(wsId, agentId) });
    },
  });
}
