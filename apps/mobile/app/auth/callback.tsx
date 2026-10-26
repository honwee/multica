import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { MulticaLogo } from "@/components/brand/multica-logo";
import { useAuthStore } from "@/data/auth-store";
import { i18n, useT } from "@/lib/i18n";
import { mapFeishuAuthError } from "@/lib/auth-error";

/** Handles Web → native OAuth handoffs for both cold and warm app starts. */
export default function AuthCallback() {
  const { t } = useT("auth");
  const loginWithToken = useAuthStore((s) => s.loginWithToken);
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const [requestError, setRequestError] = useState<string | null>(null);
  const error = token?.trim()
    ? requestError
    : t("login.feishu_invalid_callback");

  useEffect(() => {
    let cancelled = false;
    if (!token?.trim()) return;

    void loginWithToken(token)
      .then(() => {
        if (!cancelled) router.replace("/");
      })
      .catch((err) => {
        if (cancelled) return;
        setRequestError(
          mapFeishuAuthError(err, t("login.feishu_failed"), (key) =>
            i18n.t(`auth:${key}`),
          ),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [loginWithToken, t, token]);

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center gap-6 px-6">
        <MulticaLogo size={32} />
        {error ? (
          <>
            <Text className="text-center text-sm text-destructive">{error}</Text>
            <Button variant="outline" onPress={() => router.replace("/login")}>
              <Text>{t("login.continue")}</Text>
            </Button>
          </>
        ) : (
          <>
            <ActivityIndicator />
            <Text className="text-center text-sm text-muted-foreground">
              {t("login.feishu_signing_in")}
            </Text>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
