import type { AgentTask, TaskUsage } from "@multica/core/types";

const ACTIVE_STATUSES = new Set<AgentTask["status"]>([
  "queued",
  "deferred",
  "dispatched",
  "waiting_local_directory",
  "running",
]);

export function isActiveAgentRun(task: AgentTask): boolean {
  return ACTIVE_STATUSES.has(task.status);
}

export function canRetryAgentRun(
  task: AgentTask,
  tasks: readonly AgentTask[],
): boolean {
  if (!task.issue_id || (task.status !== "failed" && task.status !== "cancelled")) {
    return false;
  }
  return !tasks.some(
    (candidate) =>
      candidate.issue_id === task.issue_id &&
      candidate.agent_id === task.agent_id &&
      isActiveAgentRun(candidate),
  );
}

export function splitAgentRuns(tasks: readonly AgentTask[]): {
  active: AgentTask[];
  past: AgentTask[];
} {
  const active = tasks
    .filter(isActiveAgentRun)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const past = tasks
    .filter((task) => !isActiveAgentRun(task))
    .sort((a, b) =>
      (b.completed_at ?? b.created_at).localeCompare(
        a.completed_at ?? a.created_at,
      ),
    );
  return { active, past };
}

export function runUsageTotals(usage: readonly TaskUsage[] | undefined): {
  input: number;
  output: number;
  known: boolean;
} {
  if (!usage?.length) return { input: 0, output: 0, known: false };
  return usage.reduce(
    (total, row) => ({
      input: total.input + row.input_tokens,
      output: total.output + row.output_tokens,
      known: true,
    }),
    { input: 0, output: 0, known: true },
  );
}
