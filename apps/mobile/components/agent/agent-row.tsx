import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AgentAvailability } from "@multica/core/agents";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { PresenceDot } from "@/components/ui/presence-dot";
import { Text } from "@/components/ui/text";
import type { AgentListItem } from "@/lib/agent-list";
import { useT } from "@/lib/i18n";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";
import { cn } from "@/lib/utils";

const STATUS_LABELS = {
  online: "agent.status.online",
  unstable: "agent.status.unstable",
  offline: "agent.status.offline",
  archived: "agent.status.offline",
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
}: {
  item: AgentListItem;
  onPress: () => void;
  onEdit?: () => void;
}) {
  const { t } = useT("workspace");
  const { colorScheme } = useColorScheme();
  const { agent } = item;
  const disabled = item.disabledReason !== null;
  const modelLabel = item.model
    ? t("agent.model", { model: item.model })
    : t("agent.runtime_default");
  const statusLabel = !item.runtimeBound
    ? t("agent.runtime_required")
    : item.presence
      ? t(STATUS_LABELS[item.presence.availability])
      : t("agent.status.checking");
  const accessLabel = t(ACCESS_LABELS[item.accessScope]);
  const permissionLabel =
    item.disabledReason === "permission"
      ? t("agent.permission_unavailable")
      : null;

  return (
    <View className="flex-row items-start gap-2 px-4 py-4">
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
          <Text
            className="text-base font-medium text-foreground"
            numberOfLines={2}
          >
            {agent.name}
          </Text>
          {agent.description ? (
            <Text
              className="text-sm text-muted-foreground"
              numberOfLines={2}
            >
              {agent.description}
            </Text>
          ) : null}
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {modelLabel}
          </Text>
          <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
            <View className="flex-row items-center gap-1.5">
              {item.presence && item.runtimeBound ? (
                <PresenceDot availability={item.presence.availability} />
              ) : null}
              <Text
                className={cn(
                  "text-xs",
                  item.disabledReason === "runtime"
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
      {onEdit ? (
        <Pressable
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel={t("agent.editor.edit_a11y", { name: agent.name })}
          className="size-10 items-center justify-center self-center rounded-md active:bg-secondary"
        >
          <Ionicons
            name="create-outline"
            size={20}
            color={THEME[colorScheme].mutedForeground}
          />
        </Pressable>
      ) : !disabled ? (
        <View className="self-center">
          <Ionicons
            name="chevron-forward"
            size={18}
            color={THEME[colorScheme].mutedForeground}
          />
        </View>
      ) : null}
    </View>
  );
}
