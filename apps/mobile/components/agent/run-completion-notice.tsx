import { useEffect } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { useRunNoticeStore } from "@/data/stores/run-notice-store";
import { useChatSessionPickerStore } from "@/data/stores/chat-session-picker-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";

const AUTO_DISMISS_MS = 6_000;

export function RunCompletionNotice() {
  const notice = useRunNoticeStore((state) => state.notice);
  const dismissNotice = useRunNoticeStore((state) => state.dismissNotice);
  const wsSlug = useWorkspaceStore((state) => state.currentWorkspaceSlug);
  const insets = useSafeAreaInsets();
  const { t } = useT("workspace");

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(
      () => dismissNotice(notice.taskId),
      AUTO_DISMISS_MS,
    );
    return () => clearTimeout(timer);
  }, [dismissNotice, notice]);

  if (!notice) return null;

  const handleOpen = () => {
    dismissNotice(notice.taskId);
    if (!wsSlug) return;
    if (notice.issueId) {
      router.push({
        pathname: "/[workspace]/issue/[id]/runs",
        params: { workspace: wsSlug, id: notice.issueId },
      });
      return;
    }
    if (notice.chatSessionId) {
      useChatSessionPickerStore.getState().requestSelect(notice.chatSessionId);
      router.push({
        pathname: "/[workspace]/(tabs)/chat",
        params: { workspace: wsSlug },
      });
    }
  };

  return (
    <View
      pointerEvents="box-none"
      className="absolute left-3 right-3 z-50"
      style={{ top: insets.top + 8 }}
    >
      <Card
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        className="flex-row items-center gap-2 p-3"
        style={{
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.18,
          shadowRadius: 6,
          elevation: 4,
        }}
      >
        <Text
          className="flex-1 text-sm font-medium text-foreground"
          numberOfLines={2}
        >
          {t("run_completion.title")}
        </Text>
        <Button
          size="sm"
          variant="secondary"
          onPress={handleOpen}
          accessibilityLabel={t("run_completion.open")}
        >
          <Text>{t("run_completion.open")}</Text>
        </Button>
        <IconButton
          name="close"
          iconSize={18}
          onPress={() => dismissNotice(notice.taskId)}
          accessibilityLabel={t("run_completion.dismiss")}
        />
      </Card>
    </View>
  );
}
