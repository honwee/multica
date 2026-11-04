import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";

const CACHE_KEY = "multica-mobile-query-cache-v1";
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export function shouldPersistQueryKey(queryKey: readonly unknown[]): boolean {
  const [feature, scope, kind] = queryKey;
  if (feature === "workspaces") return true;
  if (feature === "issues" && typeof scope === "string") {
    return ["list", "my", "detail", "timeline", "attachments"].includes(
      String(kind),
    );
  }
  if (feature === "chat") {
    return (
      (typeof scope === "string" && kind === "sessions") ||
      scope === "messages"
    );
  }
  return false;
}

export function shouldPersistQuery(query: {
  queryKey: readonly unknown[];
  state: { status: string; data: unknown };
}): boolean {
  if (query.state.status !== "success" || query.state.data === undefined) {
    return false;
  }
  if (!shouldPersistQueryKey(query.queryKey)) return false;
  return !JSON.stringify(query.state.data).includes("optimistic-");
}

export const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: CACHE_KEY,
  throttleTime: 1000,
});

export const queryPersistOptions = {
  persister: queryPersister,
  maxAge: CACHE_MAX_AGE,
  buster: "v1",
  dehydrateOptions: {
    shouldDehydrateQuery: shouldPersistQuery,
  },
} as const;

export async function clearPersistedQueryCache(): Promise<void> {
  await queryPersister.removeClient();
}
