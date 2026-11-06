import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { NotificationPreferenceResponse } from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const mockGetPreferences = vi.hoisted(() => vi.fn());
const mockUpdatePreferences = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    getNotificationPreferences: mockGetPreferences,
    updateNotificationPreferences: mockUpdatePreferences,
  },
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useRequiredWorkspaceSlug: () => "acme",
  useCurrentWorkspace: () => ({ id: "ws-1", name: "Acme" }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { NotificationsTab } from "./notifications-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function renderTab(response: NotificationPreferenceResponse) {
  mockGetPreferences.mockResolvedValue(response);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en" resources={TEST_RESOURCES}>
          {children}
        </I18nProvider>
      </QueryClientProvider>
    );
  }
  return render(<NotificationsTab />, { wrapper: Wrapper });
}

const feishuLabel = enSettings.notifications.feishu.label;

describe("NotificationsTab Feishu toggle", () => {
  beforeEach(() => {
    mockGetPreferences.mockReset();
    mockUpdatePreferences.mockReset();
  });
  afterEach(cleanup);

  it("is off by default and saves the opt-in", async () => {
    mockUpdatePreferences.mockResolvedValue({
      workspace_id: "ws-1",
      preferences: { feishu_notifications: "all" },
    });
    renderTab({
      workspace_id: "ws-1",
      preferences: {},
      feishu: { available: true, reason: "" },
    });

    const toggle = await screen.findByRole("switch", { name: feishuLabel });
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled", "true"));
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(enSettings.notifications.feishu.hint)).toBeInTheDocument();

    await userEvent.click(toggle);

    await waitFor(() =>
      expect(mockUpdatePreferences).toHaveBeenCalledWith(
        { feishu_notifications: "all" },
        "acme",
      ),
    );
  });

  it("saves muted when turning it off", async () => {
    mockUpdatePreferences.mockResolvedValue({ workspace_id: "ws-1", preferences: {} });
    renderTab({
      workspace_id: "ws-1",
      preferences: { feishu_notifications: "all" },
      feishu: { available: true, reason: "" },
    });

    const toggle = await screen.findByRole("switch", { name: feishuLabel });
    await waitFor(() => expect(toggle).toBeChecked());
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(mockUpdatePreferences).toHaveBeenCalledWith(
        { feishu_notifications: "muted" },
        "acme",
      ),
    );
  });

  it("is disabled with the reason when the account has no Feishu identity", async () => {
    renderTab({
      workspace_id: "ws-1",
      preferences: { feishu_notifications: "all" },
      feishu: { available: false, reason: "not_linked" },
    });

    expect(
      await screen.findByText(enSettings.notifications.feishu.not_linked),
    ).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: feishuLabel });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).not.toBeChecked();
  });

  it("explains when the deployment has no Feishu app", async () => {
    renderTab({
      workspace_id: "ws-1",
      preferences: {},
      feishu: { available: false, reason: "not_configured" },
    });

    expect(
      await screen.findByText(enSettings.notifications.feishu.not_configured),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: feishuLabel })).toHaveAttribute("aria-disabled", "true");
  });
});
