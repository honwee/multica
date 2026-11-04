import { ActionSheetIOS, Alert, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AgentAvailability } from "@multica/core/agents";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { PresenceDot } from "@/components/ui/presence-dot";
import { Text } from "@/components/ui/text";
import { useAgentLifecycleMutation } from "@/data/mutations/agents";
import {
  agentLifecycleAction,
  type AgentListItem,
} from "@/lib/agent-list";
import { useT } from "@/lib/i18n";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";
import { cn } from "@/lib/utils";

const STATUS_LABELS = {
  online: "agent.status.online",
  unstable: "agent.status.unstable",
  offline: "agent.status.offline",
  archived: "agent.status.archived",
} as const satisfies Record<AgentAvailability, string>;

const ACCESS_LABELS = {
  workspace: "agent.access.workspace",
  "specific-people": "agent.access.specific_people",
  "owner-only": "agent.access.owner_only",
} as const;

export function AgentRow({
  item,
  onPress,
  onEdit,
  onRuns,
  canManage,
}: {
  item: AgentListItem;
  onPress: () => void;
  onEdit?: () => void;
  onRuns: () => void;
  canManage: boolean;
}) {
  const { t } = useT("workspace");
  const { colorScheme } = useColorScheme();
  const { agent } = item;
  const archived = Boolean(agent.archived_at);
  const disabled = !archived && item.disabledReason !== null;
  const lifecycle = useAgentLifecycleMutation(agent.id);
  const modelLabel = item.model
    ? t("agent.model", { model: item.model })
    : t("agent.runtime_default");
  const statusLabel = archived
    ? t("agent.status.archived")
    : !item.runtimeBound
      ? t("agent.runtime_required")
      : item.presence
        ? t(STATUS_LABELS[item.presence.availability])
        : t("agent.status.checking");
  const accessLabel = t(ACCESS_LABELS[item.accessScope]);
  const permissionLabel =
    item.disabledReason === "permission" && !archived
      ? t("agent.permission_unavailable")
      : null;

  const confirmLifecycle = (action: "archive" | "restore") => {
    Alert.alert(
      t(`agent.lifecycle.${action}_title`, { name: agent.name }),
      t(`agent.lifecycle.${action}_message`),
      [
        { text: t("common:actions.cancel"), style: "cancel" },
        {
          text: t(`agent.lifecycle.${action}_confirm`),
          style: action === "archive" ? "destructive" : "default",
          onPress: () => lifecycle.mutate(action),
        },
      ],
    );
  };

  const showActions = () => {
    const actions: { label: string; onPress: () => void; destructive?: boolean }[] = [
      { label: t("agent.runs.view"), onPress: onRuns },
    ];
    if (canManage && !archived && onEdit) {
      actions.push({ label: t("agent.lifecycle.edit"), onPress: onEdit });
    }
    const lifecycleAction = agentLifecycleAction(agent, canManage);
    if (lifecycleAction) {
      actions.push({
        label: t(`agent.lifecycle.${lifecycleAction}`),
        destructive: lifecycleAction === "archive",
        onPress: () => confirmLifecycle(lifecycleAction),
      });
    }
    const destructiveButtonIndex = actions.findIndex((action) => action.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...actions.map((action) => action.label), t("common:actions.cancel")],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex:
          destructiveButtonIndex >= 0 ? destructiveButtonIndex : undefined,
      },
      (buttonIndex) => actions[buttonIndex]?.onPress(),
    );
  };

  return (
    <View className="px-4 py-4">
      <View className="flex-row items-start gap-2">
        <Pressable
          disabled={disabled}
          onPress={onPress}
          className={cn(
            "flex-1 flex-row items-start gap-3",
            !disabled && "active:bg-secondary",
            disabled && "opacity-60",
          )}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          accessibilityLabel={[
            agent.name,
            modelLabel,
            statusLabel,
            accessLabel,
            permissionLabel,
          ]
            .filter(Boolean)
            .join(", ")}
        >
          <ActorAvatar
            type="agent"
            id={agent.id}
            name={agent.name}
            avatarUrl={agent.avatar_url}
            size={40}
          />
          <View className="flex-1 gap-1.5">
            <Text className="text-base font-medium text-foreground" numberOfLines={2}>
              {agent.name}
            </Text>
            {agent.description ? (
              <Text className="text-sm text-muted-foreground" numberOfLines={2}>
                {agent.description}
              </Text>
            ) : null}
            <Text className="text-xs text-muted-foreground" numberOfLines={2}>
              {modelLabel}
            </Text>
            <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
              <View className="flex-row items-center gap-1.5">
                {item.presence && item.runtimeBound && !archived ? (
                  <PresenceDot availability={item.presence.availability} />
                ) : null}
                <Text
                  className={cn(
                    "text-xs",
                    item.disabledReason === "runtime" && !archived
                      ? "text-warning"
                      : "text-muted-foreground",
                  )}
                >
                  {statusLabel}
                </Text>
              </View>
              <Text className="text-xs text-muted-foreground">{accessLabel}</Text>
            </View>
            {permissionLabel ? (
              <Text className="text-xs text-warning">{permissionLabel}</Text>
            ) : null}
          </View>
        </Pressable>
        <Pressable
          onPress={showActions}
          disabled={lifecycle.isPending}
          accessibilityRole="button"
          accessibilityLabel={t("agent.actions_a11y", { name: agent.name })}
          className="size-10 items-center justify-center self-center rounded-md active:bg-secondary disabled:opacity-50"
        >
          <Ionicons
            name="ellipsis-horizontal"
            size={20}
            color={THEME[colorScheme].mutedForeground}
          />
        </Pressable>
      </View>
      {lifecycle.isPending ? (
        <Text className="mt-2 text-xs text-muted-foreground">
          {t("agent.lifecycle.pending")}
        </Text>
      ) : null}
      {lifecycle.error ? (
        <Text className="mt-2 text-xs text-destructive">
          {lifecycle.error instanceof Error
            ? lifecycle.error.message
            : t("agent.lifecycle.failed")}
        </Text>
      ) : null}
    </View>
  );
}
