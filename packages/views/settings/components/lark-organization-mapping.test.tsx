// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import type { LarkInstallation } from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const organizationRef = vi.hoisted(() => ({ current: undefined as unknown }));
const agentsRef = vi.hoisted(() => ({ current: [{ id: "agent-1", name: "Review Bot" }] }));
const mockUpdate = vi.hoisted(() => vi.fn());
const mockPreview = vi.hoisted(() => vi.fn());
const mockApply = vi.hoisted(() => vi.fn());
const mockReplay = vi.hoisted(() => vi.fn());
const mockInvalidate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    if (options.enabled === false) return { data: undefined, isLoading: false, isError: false };
    const key = JSON.stringify(options.queryKey);
    if (key.includes("organization")) return { data: organizationRef.current, isLoading: false, isError: false };
    if (key.includes("agents")) return { data: agentsRef.current, isLoading: false, isError: false };
    return { data: undefined, isLoading: false, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
  queryOptions: <T,>(options: T) => options,
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/workspace", () => ({
  agentListOptions: (wsId: string) => ({ queryKey: ["workspaces", wsId, "agents"], queryFn: vi.fn() }),
}));
vi.mock("@multica/core/lark/queries", () => ({
  larkOrganizationOptions: (wsId: string) => ({ queryKey: ["lark", wsId, "organization"], queryFn: vi.fn() }),
  larkKeys: { organization: (wsId: string) => ["lark", wsId, "organization"] },
}));
vi.mock("@multica/core/api", () => ({
  api: {
    updateLarkOrganization: mockUpdate,
    previewLarkOrganization: mockPreview,
    applyLarkOrganizationSync: mockApply,
    replayLarkOrganizationSync: mockReplay,
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
    changes: [{
      user_id: "user-1",
      user_name: "Ada",
      action: "group_joined",
      group_id: "dep-1",
      group_name: "Engineering",
      before: "inactive",
      after: "active",
      reason: "Matched Engineering",
    }],
    agent_changes: [{
      agent_id: "agent-1",
      group_id: "group-1",
      group_name: "Engineering",
      action: "agent_granted",
    }],
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
    mappings: [{
      kind: "department",
      external_id: "dep-1",
      external_name: "Engineering",
      member_role: null,
      agent_ids: [],
    }],
    required_scopes: ["contact:department:readonly"],
    requirements: ["Grant the bot access to organization contacts"],
    sync_runs: [],
    catalog: {
      snapshot_at: "2026-10-27T00:00:00Z",
      departments: [
        { id: "dep-1", name: "Engineering", direct_member_count: 2, active_direct_member_count: 2 },
        { id: "dep-2", name: "Platform", direct_member_count: 3, active_direct_member_count: 3 },
        { id: "dep-3", name: "Support", direct_member_count: 1, active_direct_member_count: 1 },
      ],
      job_titles: [{ name: "Engineer", member_count: 1, active_member_count: 1 }],
      users: [
        { union_id: "union-ada", name: "Ada", job_title: "Engineer", departments: ["Engineering"], active: true, workspace_member: true },
        { union_id: "union-grace", name: "Grace", job_title: "Support", departments: ["Support"], active: true, workspace_member: false },
      ],
      total_users: 2,
      active_users: 2,
      job_title_users: 1,
      workspace_members: [{
        user_id: "user-1",
        name: "Ada",
        role: "owner",
        managed_role: "",
        disabled: false,
        linked: true,
        identity_conflict: false,
        job_title: "Engineer",
        departments: ["Engineering"],
        feishu_active: true,
      }],
    },
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
  it("shows read-only configuration and preview without write controls", async () => {
    const user = userEvent.setup();
    organizationRef.current = {
      ...baseOrganization(),
      mappings: [{ kind: "department", external_id: "dep-1", external_name: "Engineering", member_role: "admin", agent_ids: ["agent-1"] }],
      sync_runs: [previewRun],
    };
    renderUI(false);

    expect(screen.getByText(enSettings.lark.organization.read_only)).toBeTruthy();
    expect(screen.getAllByText("Engineering").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Review Bot").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("tab", { name: enSettings.lark.organization.tabs_preview }));
    expect(screen.getByText("One member could not be matched")).toBeTruthy();
    expect(screen.getByText(/Matched Engineering/)).toBeTruthy();
    expect(screen.queryByText(/group_joined/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("edits a rule through the catalog dialog and saves it", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValue(baseOrganization());
    renderUI();

    await user.click(screen.getByRole("button", { name: enSettings.lark.organization.rule_edit.replace("{{name}}", "Engineering") }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("option", { name: /Platform/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Review Bot" }));
    await user.click(within(dialog).getByRole("button", { name: enSettings.lark.organization.rule_save }));
    await user.click(screen.getByRole("button", { name: enSettings.lark.organization.save }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate).toHaveBeenCalledWith("workspace-1", {
      installation_id: installation.id,
      enabled: true,
      mappings: [{
        kind: "department",
        external_id: "dep-2",
        external_name: "Platform",
        member_role: null,
        agent_ids: ["agent-1"],
      }],
    });
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["lark", "workspace-1", "organization"] });
  }, 30000);

  it("adds an individual who is not a workspace member without inviting them", async () => {
    const user = userEvent.setup();
    renderUI();
    await user.click(screen.getByRole("button", { name: enSettings.lark.organization.rule_add }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: enSettings.lark.organization.mapping_kind }));
    await user.click(await screen.findByRole("option", { name: enSettings.lark.organization.user }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: enSettings.lark.organization.rule_source }), {
      target: { value: "Grace" },
    });
    await user.click(within(dialog).getByRole("option", { name: /Grace/ }));
    await user.click(within(dialog).getByRole("button", { name: enSettings.lark.organization.rule_save }));

    expect(await screen.findAllByText("Grace")).not.toHaveLength(0);
    expect(screen.getByText(enSettings.lark.organization.workspace_member_no)).toBeTruthy();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
  }, 30000);

  it("saves an individual rule with its role and agent selection", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValue(baseOrganization());
    renderUI();
    await user.click(screen.getByRole("button", { name: enSettings.lark.organization.rule_add }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: enSettings.lark.organization.mapping_kind }));
    await user.click(await screen.findByRole("option", { name: enSettings.lark.organization.user }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: enSettings.lark.organization.rule_source }), {
      target: { value: "Ada" },
    });
    await user.click(within(dialog).getByRole("option", { name: /Ada/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Review Bot" }));
    await user.click(within(dialog).getByRole("button", { name: enSettings.lark.organization.rule_save }));
    await user.click(screen.getByRole("button", { name: enSettings.lark.organization.save }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate).toHaveBeenCalledWith("workspace-1", {
      installation_id: installation.id,
      enabled: true,
      mappings: [
        {
          kind: "department",
          external_id: "dep-1",
          external_name: "Engineering",
          member_role: null,
          agent_ids: [],
        },
        {
          kind: "user",
          external_id: "union-ada",
          external_name: "Ada",
          member_role: "member",
          agent_ids: ["agent-1"],
        },
      ],
    });
  }, 30000);

  it("filters catalog sources before adding a rule", async () => {
    const user = userEvent.setup();
    renderUI();
    await user.click(screen.getByRole("button", { name: enSettings.lark.organization.rule_add }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: enSettings.lark.organization.rule_source }), {
      target: { value: "Support" },
    });
    expect(within(dialog).queryByRole("option", { name: /Platform/ })).toBeNull();
    await user.click(within(dialog).getByRole("option", { name: /Support/ }));
    await user.click(within(dialog).getByRole("button", { name: enSettings.lark.organization.rule_save }));
    expect(await screen.findAllByText("Support")).not.toHaveLength(0);
    expect(screen.getAllByText(enSettings.lark.organization.no_agent_grant)).toHaveLength(2);
  });

  it("previews, replays, and explicitly applies a reviewed plan with natural language", async () => {
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

    await user.click(screen.getByRole("button", { name: enSettings.lark.organization.sync_now }));
    expect(await screen.findByText("One member could not be matched")).toBeTruthy();
    expect(screen.getByText(/Matched Engineering/)).toBeTruthy();
    expect(screen.getByText((_, element) => element?.tagName === "P" && element.textContent?.includes("Join Engineering"))).toBeTruthy();
    expect(screen.queryByText(/group_joined/)).toBeNull();
    expect(screen.getByText(enSettings.lark.organization.no_role_changes)).toBeTruthy();
    expect(mockPreview).toHaveBeenCalledWith("workspace-1");

    await user.click(screen.getByRole("button", { name: enSettings.lark.organization.replay }));
    await waitFor(() => expect(mockReplay).toHaveBeenCalledWith("workspace-1", "run-1"));

    await user.click(screen.getByRole("button", { name: enSettings.lark.organization.apply }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: enSettings.lark.organization.apply }));
    await waitFor(() => expect(mockApply).toHaveBeenCalledWith("workspace-1", "run-2"));
    expect(mockInvalidate).toHaveBeenCalledTimes(3);
  }, 30000);

  it("blocks apply when the preview revision no longer matches", async () => {
    const user = userEvent.setup();
    organizationRef.current = { ...baseOrganization(), sync_runs: [{ ...previewRun, revision: 2 }] };
    renderUI();
    await user.click(screen.getByRole("tab", { name: enSettings.lark.organization.tabs_preview }));
    expect(screen.getByText(enSettings.lark.organization.stale_preview)).toBeTruthy();
    expect(screen.getByRole("button", { name: enSettings.lark.organization.apply })).toBeDisabled();
  });

  it("shows current workspace members and filters them", async () => {
    const user = userEvent.setup();
    renderUI();
    await user.click(screen.getByRole("tab", { name: enSettings.lark.organization.tabs_members }));
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("owner")).toBeTruthy();
    expect(screen.getByText("Engineer")).toBeTruthy();
    expect(screen.getByText(enSettings.lark.organization.members_linked)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: enSettings.lark.organization.members_search_placeholder }), {
      target: { value: "nobody" },
    });
    expect(screen.getByText(enSettings.lark.organization.members_no_results)).toBeTruthy();
  });

  it("shows sync history and replays from a record", async () => {
    const user = userEvent.setup();
    organizationRef.current = { ...baseOrganization(), sync_runs: [previewRun] };
    mockReplay.mockResolvedValue({ ...previewRun, id: "run-2", mode: "replay" });
    renderUI();
    await user.click(screen.getByRole("tab", { name: enSettings.lark.organization.tabs_history }));
    expect(screen.getByText(enSettings.lark.organization.history_mode_preview)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: enSettings.lark.organization.replay }));
    await waitFor(() => expect(mockReplay).toHaveBeenCalledWith("workspace-1", "run-1"));
  });
});
