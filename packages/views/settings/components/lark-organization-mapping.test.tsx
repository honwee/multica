// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import type { LarkInstallation } from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const organizationRef = vi.hoisted(() => ({ current: undefined as unknown }));
const agentsRef = vi.hoisted(() => ({
  current: [{ id: "agent-1", name: "Review Bot" }],
}));
const mockUpdate = vi.hoisted(() => vi.fn());
const mockPreview = vi.hoisted(() => vi.fn());
const mockApply = vi.hoisted(() => vi.fn());
const mockReplay = vi.hoisted(() => vi.fn());
const mockInvalidate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    if (options.enabled === false) {
      return { data: undefined, isLoading: false, isError: false };
    }
    const key = JSON.stringify(options.queryKey);
    if (key.includes("organization")) {
      return { data: organizationRef.current, isLoading: false, isError: false };
    }
    if (key.includes("agents")) {
      return { data: agentsRef.current, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
  queryOptions: <T,>(options: T) => options,
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/workspace", () => ({
  agentListOptions: (wsId: string) => ({
    queryKey: ["workspaces", wsId, "agents"],
    queryFn: vi.fn(),
  }),
}));

vi.mock("@multica/core/lark/queries", () => ({
  larkOrganizationOptions: (wsId: string) => ({
    queryKey: ["lark", wsId, "organization"],
    queryFn: vi.fn(),
  }),
  larkKeys: {
    organization: (wsId: string) => ["lark", wsId, "organization"],
  },
}));

vi.mock("@multica/core/api", () => ({
  api: {
    updateLarkOrganization: mockUpdate,
    previewLarkOrganization: mockPreview,
    applyLarkOrganizationSync: mockApply,
    replayLarkOrganizationSync: mockReplay,
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { LarkOrganizationMapping } from "./lark-organization-mapping";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };
const installation: LarkInstallation = {
  id: "installation-1",
  workspace_id: "workspace-1",
  agent_id: "agent-1",
  app_id: "cli_app",
  bot_open_id: "ou_bot",
  installer_user_id: "user-1",
  status: "active",
  installed_at: "2026-10-01T00:00:00Z",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};
const previewRun = {
  id: "run-1",
  workspace_id: "workspace-1",
  mode: "preview",
  status: "preview",
  revision: 3,
  plan: {
    changes: [
      {
        user_id: "user-1",
        user_name: "Ada",
        action: "grant",
        before: "member",
        after: "admin",
        reason: "Matched Engineering",
      },
    ],
    agent_changes: [
      {
        agent_id: "agent-1",
        group_id: "group-1",
        group_name: "Engineering",
        action: "agent_granted",
      },
    ],
    warnings: ["One member could not be matched"],
  },
  error: "",
  requested_by: "user-1",
  created_at: "2026-10-27T00:00:00Z",
  completed_at: null,
};

function baseOrganization() {
  return {
    config: {
      installation_id: installation.id,
      enabled: true,
      revision: 3,
      updated_at: "2026-10-26T00:00:00Z",
    },
    mappings: [
      {
        kind: "department",
        external_id: "dep-1",
        external_name: "Engineering",
        member_role: null,
        agent_ids: [],
      },
    ],
    required_scopes: ["contact:department:readonly"],
    requirements: ["Grant the bot access to organization contacts"],
    sync_runs: [],
  };
}

function renderUI(canManage = true) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <LarkOrganizationMapping installations={[installation]} canManage={canManage} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvalidate.mockResolvedValue(undefined);
  organizationRef.current = baseOrganization();
  agentsRef.current = [{ id: "agent-1", name: "Review Bot" }];
});

describe("LarkOrganizationMapping", () => {
  it("shows members the configuration and preview without any write controls", () => {
    organizationRef.current = {
      ...baseOrganization(),
      mappings: [
        {
          kind: "department",
          external_id: "dep-1",
          external_name: "Engineering",
          member_role: "admin",
          agent_ids: ["agent-1"],
        },
      ],
      sync_runs: [previewRun],
    };

    renderUI(false);

    expect(screen.getByText(enSettings.lark.organization.read_only)).toBeTruthy();
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.getByText("dep-1")).toBeTruthy();
    expect(screen.getAllByText("Review Bot").length).toBeGreaterThan(0);
    expect(screen.getByText("contact:department:readonly")).toBeTruthy();
    expect(screen.getByText("One member could not be matched")).toBeTruthy();
    expect(screen.getByText(/Matched Engineering/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("saves edited external IDs and agents selected by name", async () => {
    mockUpdate.mockResolvedValue(baseOrganization());
    renderUI();

    fireEvent.change(screen.getByLabelText(enSettings.lark.organization.external_id), {
      target: { value: "  dep-2  " },
    });
    fireEvent.change(screen.getByLabelText(enSettings.lark.organization.external_name), {
      target: { value: "  Platform  " },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Review Bot" }));
    fireEvent.click(screen.getByRole("button", { name: enSettings.lark.organization.save }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate).toHaveBeenCalledWith("workspace-1", {
      installation_id: installation.id,
      enabled: true,
      mappings: [
        {
          kind: "department",
          external_id: "dep-2",
          external_name: "Platform",
          member_role: null,
          agent_ids: ["agent-1"],
        },
      ],
    });
    expect(mockInvalidate).toHaveBeenCalledWith({
      queryKey: ["lark", "workspace-1", "organization"],
    });
  }, 30000);

  it("previews, replays, and explicitly applies a matching read-only plan", async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(previewRun);
    mockReplay.mockResolvedValue({ ...previewRun, id: "run-2", mode: "replay" });
    mockApply.mockResolvedValue({
      ...previewRun,
      id: "run-3",
      mode: "apply",
      status: "completed",
      completed_at: "2026-10-27T00:01:00Z",
    });
    renderUI();

    await user.click(
      screen.getByRole("button", { name: enSettings.lark.organization.preview }),
    );
    expect(await screen.findByText("One member could not be matched")).toBeTruthy();
    expect(screen.getByText(/Matched Engineering/)).toBeTruthy();
    expect(mockPreview).toHaveBeenCalledWith("workspace-1");

    await user.click(
      screen.getByRole("button", { name: enSettings.lark.organization.replay }),
    );
    await waitFor(() =>
      expect(mockReplay).toHaveBeenCalledWith("workspace-1", "run-1"),
    );

    await user.click(
      screen.getByRole("button", { name: enSettings.lark.organization.apply }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: enSettings.lark.organization.apply }),
    );
    await waitFor(() => expect(mockApply).toHaveBeenCalledWith("workspace-1", "run-2"));
    expect(mockInvalidate).toHaveBeenCalledTimes(3);
  }, 30000);

  it("blocks apply when the preview revision no longer matches", () => {
    organizationRef.current = {
      ...baseOrganization(),
      sync_runs: [{ ...previewRun, revision: 2 }],
    };
    renderUI();

    expect(screen.getByText(enSettings.lark.organization.stale_preview)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: enSettings.lark.organization.apply }),
    ).toBeDisabled();
  });
});
