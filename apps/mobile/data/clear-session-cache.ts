import { queryClient } from "@/data/query-client";
import { clearPersistedQueryCache } from "@/data/query-persistence";
import { useChatDraftsStore } from "@/data/stores/chat-drafts-store";

export async function clearSessionCache(): Promise<void> {
  queryClient.clear();
  useChatDraftsStore.getState().clearAll();
  await clearPersistedQueryCache();
}
