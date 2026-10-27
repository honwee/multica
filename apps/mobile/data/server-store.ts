import { create } from "zustand";

import {
  getBuildServerConfig,
  normalizeServerConfig,
  type ServerConfig,
} from "@/lib/server-config";

interface ServerState extends ServerConfig {
  isInitialized: boolean;
  initialize: () => Promise<void>;
  save: (config: ServerConfig) => Promise<void>;
}

function restoreConfig(raw: string | null): ServerConfig {
  if (!raw) return getBuildServerConfig();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return getBuildServerConfig();
    }
    return normalizeServerConfig({
      apiUrl: "apiUrl" in value && typeof value.apiUrl === "string"
        ? value.apiUrl
        : "",
      webUrl: "webUrl" in value && typeof value.webUrl === "string"
        ? value.webUrl
        : "",
    });
  } catch {
    return getBuildServerConfig();
  }
}

export const useServerStore = create<ServerState>((set, get) => ({
  ...getBuildServerConfig(),
  isInitialized: false,

  initialize: async () => {
    if (get().isInitialized) return;
    let raw: string | null = null;
    try {
      const { readServerConfig } = await import("./server-storage");
      raw = await readServerConfig();
    } catch {
      raw = null;
    }
    if (!get().isInitialized) {
      set({ ...restoreConfig(raw), isInitialized: true });
    }
  },

  save: async (config) => {
    const normalized = normalizeServerConfig(config);
    const { writeServerConfig } = await import("./server-storage");
    await writeServerConfig(normalized);
    set(normalized);
  },
}));

export function getCurrentServerConfig(): ServerConfig {
  const { apiUrl, webUrl } = useServerStore.getState();
  return { apiUrl, webUrl };
}
