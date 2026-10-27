import * as SecureStore from "expo-secure-store";

import type { ServerConfig } from "@/lib/server-config";

const SERVER_CONFIG_KEY = "multica_server_config_v1";

export async function readServerConfig(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_CONFIG_KEY);
}

export async function writeServerConfig(config: ServerConfig): Promise<void> {
  await SecureStore.setItemAsync(SERVER_CONFIG_KEY, JSON.stringify(config));
}
