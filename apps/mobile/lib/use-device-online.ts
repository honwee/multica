import { useNetInfo } from "@react-native-community/netinfo";
import { useAuthStore } from "@/data/auth-store";

export function useIsOffline(): boolean {
  const { isConnected, isInternetReachable } = useNetInfo();
  const restoredOffline = useAuthStore((state) => state.isRestoredOffline);
  return (
    restoredOffline || isConnected === false || isInternetReachable === false
  );
}
