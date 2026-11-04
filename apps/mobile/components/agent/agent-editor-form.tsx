import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { runtimeDisplayLabel } from "@multica/core/runtimes/display";
import type { Agent, RuntimeDevice } from "@multica/core/types";
import { api } from "@/data/api";
import { useAgentEditorStore } from "@/data/stores/agent-editor-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import {
  agentFormCreateRequest,
  agentFormUpdateRequest,
  canSubmitAgentForm,
  type AgentFormValues,
} from "@/lib/agent-form";
import { useT } from "@/lib/i18n";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { MOBILE_PLACEHOLDER_COLOR } from "@/components/ui/input-tokens";

interface Props {
  mode: "create" | "edit";
  agent?: Agent;
  runtimes: RuntimeDevice[];
  userId: string | null;
}

export function AgentEditorForm({ mode, agent, runtimes, userId }: Props) {
  const { t } = useT("workspace");
  const { colorScheme } = useColorScheme();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const wsSlug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const qc = useQueryClient();
  const values = useAgentEditorStore((s) => s.values);
  const initialize = useAgentEditorStore((s) => s.initialize);
  const setValue = useAgentEditorStore((s) => s.setValue);
  const reset = useAgentEditorStore((s) => s.reset);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEditVisibility = mode === "create" || agent?.owner_id === userId;
  const canSubmit = !submitting && canSubmitAgentForm(values);

  useEffect(() => {
    initialize(agent?.id ?? "create", agent, runtimes);
  }, [agent, initialize, runtimes]);

  function update<K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) {
    setValue(key, value);
  }

  const onSubmit = async () => {
    if (!canSubmit || !wsId) return;
    setSubmitting(true);
    setError(null);
    try {
      const saved =
        mode === "create"
          ? await api.createAgent(agentFormCreateRequest(values))
          : await api.updateAgent(agent!.id, agentFormUpdateRequest(values));
      qc.setQueryData(["agent", saved.id], saved);
      await qc.invalidateQueries({ queryKey: ["agents", wsId] });
      reset();
      router.back();
    } catch (err) {
      setError(
        t("agent.editor.save_failed", {
          message: err instanceof Error ? err.message : "unknown",
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-4 pb-8 gap-5"
        keyboardShouldPersistTaps="handled"
      >
        <Section title={t("agent.editor.name")}>
          <TextField
            value={values.name}
            onChangeText={(value) => update("name", value)}
            placeholder={t("agent.editor.name_placeholder")}
            accessibilityLabel={t("agent.editor.name")}
            autoCapitalize="sentences"
            editable={!submitting}
          />
        </Section>

        <Section title={t("agent.editor.description")}>
          <TextField
            value={values.description}
            onChangeText={(value) => update("description", value)}
            placeholder={t("agent.editor.description_placeholder")}
            accessibilityLabel={t("agent.editor.description")}
            editable={!submitting}
          />
        </Section>

        <Section title={t("agent.editor.runtime")}>
          <EditorValueRow
            value={(() => {
              const runtime = runtimes.find((item) => item.id === values.runtimeId);
              return runtime
                ? runtimeDisplayLabel(runtime)
                : values.runtimeId || t("agent.editor.runtime_placeholder");
            })()}
            placeholder={t("agent.editor.runtime_placeholder")}
            disabled={submitting || !wsSlug}
            onPress={() =>
              router.push({
                pathname:
                  mode === "create"
                    ? "/[workspace]/agent/new-picker/runtime"
                    : "/[workspace]/agent/[id]/picker/runtime",
                params: { workspace: wsSlug!, id: agent?.id },
              })
            }
          />
        </Section>

        <Section title={t("agent.editor.model")}>
          <EditorValueRow
            value={values.model || t("agent.runtime_default")}
            placeholder={t("agent.editor.model_placeholder")}
            disabled={submitting || !wsSlug || !values.runtimeId}
            onPress={() =>
              router.push({
                pathname:
                  mode === "create"
                    ? "/[workspace]/agent/new-picker/model"
                    : "/[workspace]/agent/[id]/picker/model",
                params: { workspace: wsSlug!, id: agent?.id },
              })
            }
          />
        </Section>

        <Section title={t("agent.editor.instructions")}>
          <TextInput
            value={values.instructions}
            onChangeText={(value) => update("instructions", value)}
            placeholder={t("agent.editor.instructions_placeholder")}
            placeholderTextColor={MOBILE_PLACEHOLDER_COLOR}
            accessibilityLabel={t("agent.editor.instructions")}
            multiline
            numberOfLines={8}
            editable={!submitting}
            className="min-h-40 rounded-md bg-secondary/50 px-3 py-3 text-sm text-foreground"
            style={{ textAlignVertical: "top" }}
          />
        </Section>

        <Section title={t("agent.editor.visibility")}>
          <View className="gap-2">
            <ChoiceRow
              title={t("agent.editor.workspace")}
              selected={values.visibility === "workspace"}
              onPress={() => update("visibility", "workspace")}
              disabled={submitting || !canEditVisibility}
            />
            <ChoiceRow
              title={t("agent.editor.private")}
              selected={values.visibility === "private"}
              onPress={() => update("visibility", "private")}
              disabled={submitting || !canEditVisibility}
            />
          </View>
          {!canEditVisibility ? (
            <Text className="mt-2 text-xs text-muted-foreground">
              {t("agent.editor.visibility_owner_only")}
            </Text>
          ) : null}
        </Section>

        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}

        <Button size="lg" disabled={!canSubmit} onPress={onSubmit}>
          {submitting ? (
            <ActivityIndicator color={THEME[colorScheme].primaryForeground} />
          ) : (
            <Text>
              {mode === "create"
                ? t("agent.editor.create")
                : t("agent.editor.save")}
            </Text>
          )}
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function EditorValueRow({
  value,
  placeholder,
  onPress,
  disabled,
}: {
  value: string;
  placeholder: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colorScheme } = useColorScheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 flex-row items-center gap-3 rounded-md border border-border bg-secondary/50 px-3 py-2 disabled:opacity-50"
    >
      <Text className="flex-1 text-sm text-foreground" numberOfLines={2}>
        {value || placeholder}
      </Text>
      <Ionicons
        name="chevron-forward"
        size={17}
        color={THEME[colorScheme].mutedForeground}
      />
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">{title}</Text>
      {children}
    </View>
  );
}

function ChoiceRow({
  title,
  subtitle,
  selected,
  onPress,
  disabled,
}: {
  title: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colorScheme } = useColorScheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      className={cn(
        "min-h-12 flex-row items-center gap-3 rounded-lg border px-3 py-3",
        selected ? "border-brand bg-accent" : "border-border bg-background",
        disabled && "opacity-50",
      )}
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-sm text-foreground">{title}</Text>
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
