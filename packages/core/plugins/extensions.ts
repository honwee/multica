/**
 * Fork extension points for workspace plugins (FORK.md): workspace pages and
 * plugin buttons on Feishu notification cards. Both are switched per
 * workspace in `workspace.settings.plugin_extensions` and stay off unless a
 * switch is explicitly `true` — the server applies the same rule.
 */

export const PLUGIN_EXTENSIONS_SETTINGS_KEY = "plugin_extensions";

export type PluginExtensionKey = "workspace_pages" | "card_buttons";

export type PluginExtensions = Record<PluginExtensionKey, boolean>;

export function pluginExtensionsFromSettings(settings: unknown): PluginExtensions {
  const root = isRecord(settings) ? settings[PLUGIN_EXTENSIONS_SETTINGS_KEY] : undefined;
  const switches = isRecord(root) ? root : {};
  return {
    workspace_pages: switches.workspace_pages === true,
    card_buttons: switches.card_buttons === true,
  };
}

/** The full settings object with one switch changed, for a workspace update. */
export function withPluginExtension(
  settings: unknown,
  key: PluginExtensionKey,
  enabled: boolean,
): Record<string, unknown> {
  const base = isRecord(settings) ? settings : {};
  return {
    ...base,
    [PLUGIN_EXTENSIONS_SETTINGS_KEY]: { ...pluginExtensionsFromSettings(base), [key]: enabled },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
