import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/i18n";
import { useIsOffline } from "@/lib/use-device-online";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";

export function DeviceOfflineBanner() {
  const offline = useIsOffline();
  const { t } = useT();
  const { colorScheme } = useColorScheme();
  if (!offline) return null;

  return (
    <View
      accessibilityRole="alert"
      className="flex-row items-center justify-center gap-2 border-b border-border bg-secondary px-4 py-2"
    >
      <Ionicons
        name="cloud-offline-outline"
        size={15}
        color={THEME[colorScheme].mutedForeground}
      />
      <Text className="text-xs text-muted-foreground">
        {t("states.offline_read_only")}
      </Text>
    </View>
  );
}
