import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import type { Workspace } from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const mockUpdateWorkspace = vi.hoisted(() => vi.fn());
const mockSetQueryData = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({ api: { updateWorkspace: mockUpdateWorkspace } }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ setQueryData: mockSetQueryData }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { PluginExtensionsSection } from "./plugin-extensions-section";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

function workspace(settings: Record<string, unknown>): Workspace {
  return { id: "workspace-1", name: "Acme", slug: "acme", settings } as unknown as Workspace;
}

describe("PluginExtensionsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateWorkspace.mockImplementation(async (id: string, update: { settings: unknown }) => ({ id, settings: update.settings }));
  });

  it("shows both switches off by default", () => {
    render(<PluginExtensionsSection workspace={workspace({})} canManage />, { wrapper: Wrapper });
    expect(screen.getByRole("switch", { name: "Plugin pages in the sidebar" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Plugin buttons on Feishu notification cards" })).not.toBeChecked();
  });

  it("turns one switch on without touching other settings", async () => {
    const user = userEvent.setup();
    render(<PluginExtensionsSection workspace={workspace({ github_enabled: true })} canManage />, { wrapper: Wrapper });
    await user.click(screen.getByRole("switch", { name: "Plugin pages in the sidebar" }));
    await waitFor(() => expect(mockUpdateWorkspace).toHaveBeenCalledTimes(1));
    expect(mockUpdateWorkspace).toHaveBeenCalledWith("workspace-1", {
      settings: { github_enabled: true, plugin_extensions: { workspace_pages: true, card_buttons: false } },
    });
  });

  it("is read-only for members who cannot manage the workspace", () => {
    render(
      <PluginExtensionsSection workspace={workspace({ plugin_extensions: { card_buttons: true } })} canManage={false} />,
      { wrapper: Wrapper },
    );
    const cards = screen.getByRole("switch", { name: "Plugin buttons on Feishu notification cards" });
    expect(cards).toBeChecked();
    expect(cards).toHaveAttribute("aria-disabled", "true");
  });
});
