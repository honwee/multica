import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";

import { Button } from "@/components/ui/button";
import { ModalCloseButton } from "@/components/ui/modal-close-button";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { useAuthStore } from "@/data/auth-store";
import { useServerStore } from "@/data/server-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import {
  getFeishuWebCallbackUrl,
  MULTICA_AUTH_CALLBACK_URL,
  resolveFeishuWebUrl,
} from "@/lib/feishu-auth";
import { useT } from "@/lib/i18n";
import {
  getBuildServerConfig,
  normalizeServerUrl,
  serverConfigsEqual,
  ServerUrlError,
  type ServerConfig,
} from "@/lib/server-config";
import {
  ServerConnectionError,
  testServerConnection,
} from "@/lib/server-connection";

type ServerField = keyof ServerConfig;

export function ServerSettingsScreen() {
  const { t } = useT("settings");
  const { t: tCommon } = useT();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const apiUrl = useServerStore((s) => s.apiUrl);
  const webUrl = useServerStore((s) => s.webUrl);
  const serverInitialized = useServerStore((s) => s.isInitialized);
  const [draftApiUrl, setDraftApiUrl] = useState(apiUrl);
  const [draftWebUrl, setDraftWebUrl] = useState(webUrl);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<ServerField | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const buildConfig = getBuildServerConfig();
  const activeConfig = { apiUrl, webUrl };
  const isDefault = serverConfigsEqual(activeConfig, buildConfig);
  const isDraftDefault =
    draftApiUrl === buildConfig.apiUrl && draftWebUrl === buildConfig.webUrl;
  const draftWebOrigin = resolveFeishuWebUrl(draftWebUrl);
  const webCallbackUrl = draftWebOrigin
    ? getFeishuWebCallbackUrl(draftWebOrigin)
    : "—";
  const busy = testing || saving;

  if (!serverInitialized) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  const readDraft = (): ServerConfig | null => {
    let normalizedApiUrl: string;
    let normalizedWebUrl: string;
    try {
      normalizedApiUrl = normalizeServerUrl(draftApiUrl);
    } catch (cause) {
      setErrorField("apiUrl");
      setError(t(`server.errors.${cause instanceof ServerUrlError ? cause.code : "invalid"}`));
      return null;
    }
    try {
      normalizedWebUrl = normalizeServerUrl(draftWebUrl);
    } catch (cause) {
      setErrorField("webUrl");
      setError(t(`server.errors.${cause instanceof ServerUrlError ? cause.code : "invalid"}`));
      return null;
    }
    setErrorField(null);
    setError(null);
    return { apiUrl: normalizedApiUrl, webUrl: normalizedWebUrl };
  };

  const updateDraft = (field: ServerField, value: string) => {
    if (field === "apiUrl") setDraftApiUrl(value);
    else setDraftWebUrl(value);
    setError(null);
    setErrorField(null);
    setSuccess(null);
  };

  const onTest = async () => {
    const config = readDraft();
    if (!config || busy) return;
    setTesting(true);
    setSuccess(null);
    try {
      await testServerConnection(config.apiUrl);
      setSuccess(t("server.test_success"));
    } catch (cause) {
      setErrorField("apiUrl");
      if (cause instanceof ServerConnectionError) {
        setError(
          cause.code === "http"
            ? t("server.errors.http", { status: cause.status ?? 0 })
            : t(`server.errors.${cause.code}`),
        );
      } else {
        setError(t("server.errors.network"));
      }
    } finally {
      setTesting(false);
    }
  };

  const performSave = async (config: ServerConfig, changed: boolean) => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      if (changed) {
        await useAuthStore.getState().logout();
        await useWorkspaceStore.getState().clear();
        queryClient.clear();
      }
      await useServerStore.getState().save(config);
      if (changed) {
        router.replace("/login");
        return;
      }
      setSuccess(t("server.saved"));
    } catch {
      setError(t("server.errors.save_failed"));
    } finally {
      setSaving(false);
    }
  };

  const onSave = () => {
    const config = readDraft();
    if (!config || busy) return;
    const changed = !serverConfigsEqual(activeConfig, config);
    if (!changed || !user) {
      void performSave(config, changed);
      return;
    }
    Alert.alert(
      t("server.change_title"),
      t("server.change_message"),
      [
        { text: tCommon("actions.cancel"), style: "cancel" },
        {
          text: t("server.change_confirm"),
          style: "destructive",
          onPress: () => void performSave(config, true),
        },
      ],
    );
  };

  const useDefault = () => {
    setDraftApiUrl(buildConfig.apiUrl);
    setDraftWebUrl(buildConfig.webUrl);
    setError(null);
    setErrorField(null);
    setSuccess(null);
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View className="flex-row items-center justify-between px-4 pt-4 pb-3">
        <Text className="text-base font-semibold text-foreground">
          {t("server.title")}
        </Text>
        <ModalCloseButton />
      </View>
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="px-4 pb-8 gap-5"
      >
        <View className="gap-2">
          <Text className="text-sm text-muted-foreground">
            {t("server.origin_help")}
          </Text>
          {user ? (
            <Text className="text-sm text-muted-foreground">
              {t("server.signed_in_help")}
            </Text>
          ) : null}
          <Text className="text-xs text-muted-foreground">
            {t("server.environment", {
              value: isDefault ? t("server.default") : t("server.custom"),
            })}
          </Text>
        </View>

        <View className="gap-4">
          <Field
            label={t("server.api_url")}
            value={draftApiUrl}
            onChange={(value) => updateDraft("apiUrl", value)}
            invalid={errorField === "apiUrl"}
            editable={!busy}
          />
          <Field
            label={t("server.web_url")}
            value={draftWebUrl}
            onChange={(value) => updateDraft("webUrl", value)}
            invalid={errorField === "webUrl"}
            editable={!busy}
          />
          {error ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-destructive">
              {error}
            </Text>
          ) : null}
          {success ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
              {success}
            </Text>
          ) : null}
        </View>

        <View className="flex-row gap-3">
          <Button variant="outline" className="flex-1" disabled={busy} onPress={onTest}>
            <Text>{testing ? t("server.testing") : t("server.test")}</Text>
          </Button>
          <Button className="flex-1" disabled={busy} onPress={onSave}>
            <Text>{saving ? t("server.saving") : t("server.save")}</Text>
          </Button>
        </View>
        <Button variant="ghost" disabled={busy || isDraftDefault} onPress={useDefault}>
          <Text>{t("server.use_default")}</Text>
        </Button>

        <View className="gap-3 rounded-md border border-border bg-card p-4">
          <Text className="text-sm font-medium text-foreground">
            {t("server.oauth_title")}
          </Text>
          <CallbackRow
            label={t("server.web_callback")}
            value={webCallbackUrl}
          />
          <CallbackRow
            label={t("server.native_callback")}
            value={MULTICA_AUTH_CALLBACK_URL}
          />
          <Text className="text-xs text-muted-foreground">
            {t("server.oauth_help")}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  value,
  onChange,
  invalid,
  editable,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  editable: boolean;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      <TextField
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://multica.example.com"
        value={value}
        onChangeText={onChange}
        invalid={invalid}
        editable={editable}
      />
    </View>
  );
}

function CallbackRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      <Text selectable className="text-xs text-foreground">
        {value}
      </Text>
    </View>
  );
}
