import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { isRuntimeUsableForUser } from "@multica/core/runtimes/access";
import { runtimeDisplayLabel } from "@multica/core/runtimes/display";
import type { RuntimeDevice } from "@multica/core/types";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { agentDetailOptions } from "@/data/queries/agents";
import {
  runtimeListOptions,
  runtimeModelsOptions,
} from "@/data/queries/runtimes";
import { useAgentEditorStore } from "@/data/stores/agent-editor-store";
import { useAuthStore } from "@/data/auth-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";
import { cn } from "@/lib/utils";

export function AgentEditorPickerRoute({
  kind,
  agentId,
}: {
  kind: "runtime" | "model";
  agentId?: string;
}) {
  const { t } = useT("workspace");
  const wsId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const runtimesQuery = useQuery(runtimeListOptions(wsId));
  const agentQuery = useQuery(agentDetailOptions(agentId ?? null));
  const values = useAgentEditorStore((state) => state.values);
  const initialize = useAgentEditorStore((state) => state.initialize);
  const setValue = useAgentEditorStore((state) => state.setValue);
  const selectRuntimeValue = useAgentEditorStore((state) => state.selectRuntime);
  const runtimes = useMemo(() => runtimesQuery.data ?? [], [runtimesQuery.data]);
  const currentRuntime = runtimes.find((runtime) => runtime.id === values.runtimeId);
  const canDiscover = Boolean(
    currentRuntime &&
      currentRuntime.status === "online" &&
      isRuntimeUsableForUser(currentRuntime, userId),
  );
  const modelsQuery = useQuery(
    runtimeModelsOptions(wsId, values.runtimeId || null, canDiscover),
  );
  useEffect(() => {
    if (runtimesQuery.isLoading || (agentId && !agentQuery.data)) return;
    initialize(agentId ?? "create", agentQuery.data, runtimes);
  }, [agentId, agentQuery.data, initialize, runtimes, runtimesQuery.isLoading]);

  const selectRuntime = (runtime: RuntimeDevice) => {
    selectRuntimeValue(runtime.id);
    router.back();
  };
  const selectModel = (model: string) => {
    setValue("model", model.trim());
    router.back();
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 pb-8 pt-4"
        keyboardShouldPersistTaps="handled"
      >
        <Text className="mb-4 text-lg font-semibold text-foreground">
          {t(`agent.editor.${kind}`)}
        </Text>
        {kind === "runtime" ? (
          <RuntimeChoices
            runtimes={runtimes}
            currentId={values.runtimeId}
            userId={userId}
            loading={runtimesQuery.isLoading}
            error={runtimesQuery.error}
            onRetry={() => void runtimesQuery.refetch()}
            onSelect={selectRuntime}
          />
        ) : (
          <View className="gap-5">
            <PickerRow
              title={t("agent.runtime_default")}
              selected={!values.model}
              onPress={() => selectModel("")}
            />
            {!canDiscover ? (
              <Text className="text-sm text-muted-foreground">
                {t("agent.editor.models_offline")}
              </Text>
            ) : modelsQuery.isLoading ? (
              <View className="flex-row items-center gap-2 py-2">
                <ActivityIndicator />
                <Text className="text-sm text-muted-foreground">
                  {t("agent.editor.models_loading")}
                </Text>
              </View>
            ) : modelsQuery.isError ? (
              <View className="gap-2">
                <Text className="text-sm text-muted-foreground">
                  {t("agent.editor.models_offline")}
                </Text>
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  onPress={() => void modelsQuery.refetch()}
                >
                  <Text>{t("common:actions.retry")}</Text>
                </Button>
              </View>
            ) : modelsQuery.data?.supported === false ? (
              <Text className="text-sm text-muted-foreground">
                {t("agent.editor.models_managed")}
              </Text>
            ) : modelsQuery.data ? (
              <View className="gap-2">
                {modelsQuery.data.models.map((model) => (
                  <PickerRow
                    key={model.id}
                    title={model.label || model.id}
                    subtitle={model.default ? t("agent.editor.runtime_recommended") : undefined}
                    selected={values.model === model.id}
                    onPress={() => selectModel(model.id)}
                  />
                ))}
                {!modelsQuery.data.models.length ? (
                  <Text className="text-sm text-muted-foreground">
                    {t("agent.editor.models_empty")}
                  </Text>
                ) : null}
                {modelsQuery.data.unavailableModels?.map((model) => (
                  <PickerRow
                    key={model.id}
                    title={model.label || model.id}
                    subtitle={model.reason || t("agent.editor.model_unavailable")}
                    disabled
                  />
                ))}
              </View>
            ) : (
              <Text className="text-sm text-muted-foreground">
                {t("agent.editor.models_offline")}
              </Text>
            )}

            {values.model &&
            !modelsQuery.data?.models.some((model) => model.id === values.model) ? (
              <PickerRow
                title={values.model}
                subtitle={t("agent.editor.saved_custom_model")}
                selected
                onPress={() => selectModel(values.model)}
              />
            ) : null}

            <CustomModelEditor
              key={values.model}
              initialValue={values.model}
              onSelect={selectModel}
            />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function CustomModelEditor({
  initialValue,
  onSelect,
}: {
  initialValue: string;
  onSelect: (model: string) => void;
}) {
  const { t } = useT("workspace");
  const [value, setValue] = useState(initialValue);
  return (
    <View className="gap-2 border-t border-border pt-4">
      <Text className="text-sm font-medium text-foreground">
        {t("agent.editor.custom_model")}
      </Text>
      <TextField
        value={value}
        onChangeText={setValue}
        placeholder={t("agent.editor.model_placeholder")}
        accessibilityLabel={t("agent.editor.custom_model")}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button onPress={() => onSelect(value)}>
        <Text>{t("agent.editor.use_custom_model")}</Text>
      </Button>
    </View>
  );
}

function RuntimeChoices({
  runtimes,
  currentId,
  userId,
  loading,
  error,
  onRetry,
  onSelect,
}: {
  runtimes: RuntimeDevice[];
  currentId: string;
  userId: string | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onSelect: (runtime: RuntimeDevice) => void;
}) {
  const { t } = useT("workspace");
  if (loading) {
    return (
      <View className="items-center py-8">
        <ActivityIndicator />
      </View>
    );
  }
  if (error) {
    return (
      <View className="gap-3">
        <Text className="text-sm text-destructive">
          {error instanceof Error ? error.message : t("common:states.error")}
        </Text>
        <Button size="sm" variant="outline" className="self-start" onPress={onRetry}>
          <Text>{t("common:actions.retry")}</Text>
        </Button>
      </View>
    );
  }
  const savedMissing = currentId && !runtimes.some((runtime) => runtime.id === currentId);
  return (
    <View className="gap-2">
      {runtimes.map((runtime) => {
        const usable = isRuntimeUsableForUser(runtime, userId);
        return (
          <PickerRow
            key={runtime.id}
            title={runtimeDisplayLabel(runtime)}
            subtitle={`${t(`agent.status.${runtime.status}`)}${
              usable ? "" : ` · ${t("agent.editor.runtime_no_access")}`
            }`}
            selected={currentId === runtime.id}
            disabled={!usable && currentId !== runtime.id}
            onPress={() => onSelect(runtime)}
          />
        );
      })}
      {savedMissing ? (
        <PickerRow
          title={currentId}
          subtitle={t("agent.editor.saved_custom_runtime")}
          selected
          disabled
        />
      ) : null}
      {!runtimes.length && !savedMissing ? (
        <View className="gap-3 py-4">
          <Text className="text-sm text-muted-foreground">
            {t("agent.editor.runtimes_empty")}
          </Text>
          <Button size="sm" variant="outline" className="self-start" onPress={onRetry}>
            <Text>{t("common:actions.retry")}</Text>
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function PickerRow({
  title,
  subtitle,
  selected = false,
  disabled = false,
  onPress,
}: {
  title: string;
  subtitle?: string;
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}) {
  const { colorScheme } = useColorScheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled || !onPress}
      onPress={onPress}
      className={cn(
        "min-h-12 flex-row items-center gap-3 rounded-lg border px-3 py-3",
        selected ? "border-brand bg-accent" : "border-border bg-background",
        disabled && "opacity-60",
      )}
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-sm text-foreground" numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text className="text-xs text-muted-foreground">{subtitle}</Text>
        ) : null}
      </View>
      {selected ? (
        <Ionicons name="checkmark" size={18} color={THEME[colorScheme].brand} />
      ) : null}
    </Pressable>
  );
}
