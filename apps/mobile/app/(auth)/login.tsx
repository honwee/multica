import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { MulticaLogo } from "@/components/brand/multica-logo";
import { useAuthStore } from "@/data/auth-store";
import { appConfigOptions } from "@/data/queries/billing";
import { i18n, useT } from "@/lib/i18n";
import { mapAuthError, mapFeishuAuthError } from "@/lib/auth-error";
import {
  buildFeishuAuthorizationUrl,
  FeishuCallbackError,
  MULTICA_AUTH_CALLBACK_URL,
  parseFeishuCallbackUrl,
  resolveFeishuWebUrl,
} from "@/lib/feishu-auth";

export default function Login() {
  const { t } = useT("auth");
  const sendCode = useAuthStore((s) => s.sendCode);
  const loginWithToken = useAuthStore((s) => s.loginWithToken);
  const { data: config } = useQuery(appConfigOptions());
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feishuSubmitting, setFeishuSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feishuError, setFeishuError] = useState<string | null>(null);

  const feishuAppId = config?.feishu_app_id?.trim() ?? "";
  const feishuWebUrl = resolveFeishuWebUrl(
    process.env.EXPO_PUBLIC_WEB_URL,
    process.env.EXPO_PUBLIC_API_URL,
  );
  const feishuAvailable = Boolean(feishuAppId && feishuWebUrl);
  const isBusy = submitting || feishuSubmitting;

  const onSubmit = async () => {
    const trimmed = email.trim();
    if (!trimmed || isBusy) return;
    void Haptics.selectionAsync();
    setSubmitting(true);
    setError(null);
    setFeishuError(null);
    try {
      await sendCode(trimmed);
      router.push({ pathname: "/verify", params: { email: trimmed } });
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(mapAuthError(err, t("login.send_failed"), (key) => i18n.t(`auth:${key}`)));
    } finally {
      setSubmitting(false);
    }
  };

  const onFeishuSubmit = async () => {
    if (!feishuAppId || !feishuWebUrl || isBusy) return;
    void Haptics.selectionAsync();
    setFeishuSubmitting(true);
    setError(null);
    setFeishuError(null);
    try {
      const result = await WebBrowser.openAuthSessionAsync(
        buildFeishuAuthorizationUrl({ appId: feishuAppId, webUrl: feishuWebUrl }),
        MULTICA_AUTH_CALLBACK_URL,
      );
      if (result.type === "cancel" || result.type === "dismiss") return;
      if (result.type !== "success") {
        throw new Error("Feishu authorization did not complete");
      }

      const token = parseFeishuCallbackUrl(result.url);
      await loginWithToken(token);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/");
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setFeishuError(
        err instanceof FeishuCallbackError
          ? t("login.feishu_invalid_callback")
          : mapFeishuAuthError(err, t("login.feishu_failed"), (key) =>
              i18n.t(`auth:${key}`),
            ),
      );
    } finally {
      setFeishuSubmitting(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="flex-grow justify-center px-6 gap-6"
        >
          <View className="items-center gap-3">
            <MulticaLogo size={32} />
            <View className="gap-1 items-center">
              <Text className="text-2xl font-semibold text-foreground">
                {t("login.title")}
              </Text>
              <Text className="text-sm text-muted-foreground text-center">
                {t("login.subtitle")}
              </Text>
            </View>
          </View>

          <View className="gap-3">
            <TextField
              autoCapitalize="none"
              autoComplete="email"
              autoFocus
              keyboardType="email-address"
              placeholder={t("login.email_placeholder")}
              value={email}
              onChangeText={setEmail}
              onSubmitEditing={onSubmit}
              returnKeyType="send"
              editable={!isBusy}
              invalid={!!error}
            />
            {error ? (
              <Text className="text-sm text-destructive">{error}</Text>
            ) : null}
          </View>

          <Button
            size="lg"
            disabled={isBusy || !email.trim()}
            onPress={onSubmit}
          >
            <Text>{submitting ? t("login.sending") : t("login.send_code")}</Text>
          </Button>

          {feishuAvailable ? (
            <View className="gap-3">
              <View className="flex-row items-center gap-3">
                <Separator className="flex-1" />
                <Text className="text-xs text-muted-foreground">{t("login.or")}</Text>
                <Separator className="flex-1" />
              </View>
              <Button
                variant="outline"
                size="lg"
                disabled={isBusy}
                onPress={onFeishuSubmit}
              >
                <Text>
                  {feishuSubmitting
                    ? t("login.feishu_signing_in")
                    : t("login.continue_with_feishu")}
                </Text>
              </Button>
              {feishuError ? (
                <Text className="text-sm text-destructive text-center">
                  {feishuError}
                </Text>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
