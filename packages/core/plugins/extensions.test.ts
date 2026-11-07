// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pluginExtensionsFromSettings, withPluginExtension } from "./extensions";

describe("pluginExtensionsFromSettings", () => {
  it("is off unless a switch is explicitly true", () => {
    for (const settings of [undefined, null, {}, [], { plugin_extensions: [true] }, { plugin_extensions: { workspace_pages: "true", card_buttons: 1 } }]) {
      expect(pluginExtensionsFromSettings(settings)).toEqual({ workspace_pages: false, card_buttons: false });
    }
    expect(pluginExtensionsFromSettings({ plugin_extensions: { workspace_pages: true } })).toEqual({
      workspace_pages: true,
      card_buttons: false,
    });
  });
});

describe("withPluginExtension", () => {
  it("changes one switch and keeps every other setting", () => {
    const next = withPluginExtension(
      { github_enabled: true, plugin_extensions: { workspace_pages: true, unknown: "x" } },
      "card_buttons",
      true,
    );
    expect(next).toEqual({
      github_enabled: true,
      plugin_extensions: { workspace_pages: true, card_buttons: true },
    });
  });
});
