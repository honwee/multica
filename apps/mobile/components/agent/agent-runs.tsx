import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { runtimeDisplayLabel } from "@multica/core/runtimes/display";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Agent, AgentTask } from "@multica/core/types";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { ChatTimeline } from "@/components/chat/chat-timeline";
import {
  useCancelAgentRun,
  useRetryAgentRun,
} from "@/data/mutations/agents";
import { agentRunsOptions } from "@/data/queries/agents";
import { runtimeListOptions } from "@/data/queries/runtimes";
import { taskMessagesOptions } from "@/data/queries/chat";
import { useWorkspaceStore } from "@/data/workspace-store";
import {
  canRetryAgentRun,
  isActiveAgentRun,
  runUsageTotals,
  splitAgentRuns,
} from "@/lib/agent-run";
import { failureReasonKey, REASONS } from "@/lib/failure-reason-label";
import { useT } from "@/lib/i18n";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";
import { cn } from "@/lib/utils";

export function AgentRuns({ agentId, agent }: { agentId: string; agent?: Agent }) {
  const { t } = useT("workspace");
  const wsId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const wsSlug = useWorkspaceStore((state) => state.currentWorkspaceSlug);
  const runsQuery = useInfiniteQuery(agentRunsOptions(wsId, agentId));
  const runtimesQuery = useQuery(runtimeListOptions(wsId));
  const [retriedIds, setRetriedIds] = useState<Set<string>>(() => new Set());
  const tasks = useMemo(
    () => runsQuery.data?.pages.flatMap((page) => page.tasks) ?? [],
    [runsQuery.data],
  );
  const { active, past } = useMemo(() => splitAgentRuns(tasks), [tasks]);
  const runtime = runtimesQuery.data?.find((item) => item.id === agent?.runtime_id);
  const model = agent?.model?.trim() || t("agent.runtime_default");

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="px-4 pt-4 pb-8 gap-5"
      refreshControl={
        <RefreshControl
          refreshing={runsQuery.isRefetching && !runsQuery.isFetchingNextPage}
          onRefresh={() => void runsQuery.refetch()}
        />
      }
    >
      {agent ? (
        <View className="gap-1 rounded-lg bg-secondary/50 px-3 py-3">
          <Text className="text-sm font-medium text-foreground" numberOfLines={2}>
            {runtime ? runtimeDisplayLabel(runtime) : t("agent.runtime_required")}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {model}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t("agent.runs.quota_unavailable")}
          </Text>
        </View>
      ) : null}

      {runsQuery.isLoading ? (
        <View className="items-center py-12">
          <ActivityIndicator />
        </View>
      ) : runsQuery.isError && tasks.length === 0 ? (
        <View className="gap-3">
          <Text className="text-sm text-destructive">
            {t("agent.runs.load_failed", {
              message:
                runsQuery.error instanceof Error
                  ? runsQuery.error.message
                  : "unknown",
            })}
          </Text>
          <Button
            variant="outline"
            className="self-start"
            onPress={() => void runsQuery.refetch()}
          >
            <Text>{t("common:actions.retry")}</Text>
          </Button>
        </View>
      ) : tasks.length === 0 ? (
        <View className="items-center gap-2 px-6 py-12">
          <Text className="text-base font-medium text-foreground">
            {t("agent.runs.empty")}
          </Text>
          <Text className="text-center text-sm text-muted-foreground">
            {t("agent.runs.empty_detail")}
          </Text>
        </View>
      ) : (
        <>
          {active.length ? (
            <RunSection title={t("agent.runs.active")}>
              {active.map((task) => (
                <AgentRunCard
                  key={task.id}
                  task={task}
                  tasks={tasks}
                  wsSlug={wsSlug}
                  retried={retriedIds.has(task.id)}
                  onRetried={(id) =>
                    setRetriedIds((current) => new Set(current).add(id))
                  }
                />
              ))}
            </RunSection>
          ) : null}
          {past.length ? (
            <RunSection title={t("agent.runs.past")}>
              {past.map((task) => (
                <AgentRunCard
                  key={task.id}
                  task={task}
                  tasks={tasks}
                  wsSlug={wsSlug}
                  retried={retriedIds.has(task.id)}
                  onRetried={(id) =>
                    setRetriedIds((current) => new Set(current).add(id))
                  }
                />
              ))}
            </RunSection>
          ) : null}
        </>
      )}

      {runsQuery.hasNextPage ? (
        <Button
          variant="outline"
          disabled={runsQuery.isFetchingNextPage}
          onPress={() => void runsQuery.fetchNextPage()}
        >
          {runsQuery.isFetchingNextPage ? (
            <ActivityIndicator />
          ) : (
            <Text>{t("agent.runs.load_more")}</Text>
          )}
        </Button>
      ) : null}
      {runsQuery.isFetchNextPageError ? (
        <Text className="text-sm text-destructive">
          {t("agent.runs.load_more_failed")}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function RunSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-2">
      <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </Text>
      <View className="gap-3">{children}</View>
    </View>
  );
}

function AgentRunCard({
  task,
  tasks,
  wsSlug,
  retried,
  onRetried,
}: {
  task: AgentTask;
  tasks: readonly AgentTask[];
  wsSlug: string | null;
  retried: boolean;
  onRetried: (taskId: string) => void;
}) {
  const { t } = useT("workspace");
  const { colorScheme } = useColorScheme();
  const [expanded, setExpanded] = useState(false);
  const cancelMutation = useCancelAgentRun(task.agent_id);
  const retryMutation = useRetryAgentRun(task.agent_id);
  const active = isActiveAgentRun(task);
  const canRetry = !retried && canRetryAgentRun(task, tasks);
  const timestamp = task.completed_at ?? task.started_at ?? task.created_at;
  const failure =
    task.failure_reason && REASONS.has(task.failure_reason)
      ? t(`chat:${failureReasonKey(task.failure_reason)}`)
      : undefined;
  const usage = runUsageTotals(task.usage);
  const actionError = cancelMutation.error ?? retryMutation.error;

  const cancel = () => {
    Alert.alert(t("agent.runs.cancel_title"), t("agent.runs.cancel_message"), [
      { text: t("agent.runs.keep_running"), style: "cancel" },
      {
        text: t("agent.runs.cancel_confirm"),
        style: "destructive",
        onPress: () => cancelMutation.mutate(task),
      },
    ]);
  };

  return (
    <View className="rounded-lg border border-border bg-background px-3 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={t("agent.runs.details_a11y")}
        onPress={() => setExpanded((value) => !value)}
        className="flex-row items-start gap-3 active:opacity-70"
      >
        <View className="flex-1 gap-1.5">
          <Text className="text-sm font-medium text-foreground" numberOfLines={3}>
            {runKindSummary(task, t)}
          </Text>
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
            <Text
              className={cn(
                "text-xs",
                task.status === "failed" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {t(`agent.runs.status.${task.status}`)}
              {failure ? ` · ${failure}` : ""}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {formatRunTime(timestamp)}
            </Text>
          </View>
          {task.issue_id ? (
            <Text className="text-xs text-muted-foreground">
              {t("agent.runs.linked_issue")}
            </Text>
          ) : null}
        </View>
        <Ionicons
          name={expanded ? "chevron-down" : "chevron-forward"}
          size={17}
          color={THEME[colorScheme].mutedForeground}
        />
      </Pressable>

      {task.error ? (
        <Text className="mt-2 text-xs text-destructive">{task.error}</Text>
      ) : null}

      <View className="mt-3 flex-row flex-wrap items-center gap-2">
        {task.issue_id && wsSlug ? (
          <Button
            size="sm"
            variant="ghost"
            onPress={() =>
              router.push({
                pathname: "/[workspace]/issue/[id]",
                params: { workspace: wsSlug, id: task.issue_id },
              })
            }
          >
            <Text>{t("agent.runs.open_issue")}</Text>
          </Button>
        ) : null}
        {active ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={cancelMutation.isPending}
            onPress={cancel}
          >
            {cancelMutation.isPending ? (
              <ActivityIndicator />
            ) : (
              <Text>{t("agent.runs.cancel")}</Text>
            )}
          </Button>
        ) : null}
        {canRetry ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={retryMutation.isPending}
            onPress={() =>
              retryMutation.mutate(task, {
                onSuccess: () => onRetried(task.id),
              })
            }
          >
            {retryMutation.isPending ? (
              <ActivityIndicator />
            ) : (
              <Text>{t("agent.runs.retry")}</Text>
            )}
          </Button>
        ) : null}
        {retried ? (
          <Text className="px-2 text-xs text-muted-foreground">
            {t("agent.runs.retry_queued")}
          </Text>
        ) : null}
      </View>
      {actionError ? (
        <Text className="mt-2 text-xs text-destructive">
          {actionError instanceof Error
            ? actionError.message
            : t("agent.runs.action_failed")}
        </Text>
      ) : null}

      {expanded ? (
        <View className="mt-3 gap-2 border-t border-border pt-3">
          <Text className="text-xs text-muted-foreground">
            {usage.known
              ? t("agent.runs.usage", {
                  input: usage.input.toLocaleString(),
                  output: usage.output.toLocaleString(),
                })
              : t("agent.runs.usage_unavailable")}
          </Text>
          <RunTranscript task={task} />
        </View>
      ) : null}
    </View>
  );
}

function RunTranscript({ task }: { task: AgentTask }) {
  const { t } = useT("workspace");
  const options = taskMessagesOptions(task.id);
  const query = useQuery({ ...options, enabled: options.enabled });
  if (query.isLoading) return <ActivityIndicator className="self-start" />;
  if (query.isError) {
    return (
      <View className="gap-2">
        <Text className="text-xs text-destructive">
          {t("agent.runs.transcript_failed")}
        </Text>
        <Button size="sm" variant="outline" onPress={() => void query.refetch()}>
          <Text>{t("common:actions.retry")}</Text>
        </Button>
      </View>
    );
  }
  const messages = query.data ?? [];
  const textMessages = messages.filter(
    (message) => message.type === "text" && message.content?.trim(),
  );
  if (!messages.length) {
    return (
      <Text className="text-xs text-muted-foreground">
        {t("agent.runs.no_transcript")}
      </Text>
    );
  }
  return (
    <View className="gap-2">
      <ChatTimeline items={messages} isStreaming={isActiveAgentRun(task)} />
      {textMessages.map((message, index) => (
        <Text key={index} className="text-xs text-foreground">
          {message.content}
        </Text>
      ))}
    </View>
  );
}

function runKindSummary(
  task: AgentTask,
  t: (key: string) => string,
): string {
  if (task.trigger_summary?.trim()) return task.trigger_summary.trim();
  switch (task.kind) {
    case "comment":
      return t("issues:summary.comment");
    case "autopilot":
      return t("issues:summary.autopilot");
    case "chat":
      return t("issues:summary.chat");
    case "quick_create":
      return t("issues:summary.quick_create");
    case "direct":
    default:
      return t("issues:summary.direct");
  }
}

function formatRunTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
