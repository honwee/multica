import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../locales/en/common.json";
import enIssues from "../locales/en/issues.json";
import enLayout from "../locales/en/layout.json";

const data = vi.hoisted(() => ({
  installed: { plugins: [] as Array<Record<string, unknown>> },
  settings: {} as Record<string, unknown>,
  flagEnabled: true,
  queried: [] as boolean[],
  launch: null as { url: string; bridge_token: string } | null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: readonly unknown[]; enabled?: boolean }) => {
    if (options?.queryKey?.[0] === "surface") return { data: data.launch, isPending: !data.launch, isError: false };
    data.queried.push(options.enabled !== false);
    return { data: options.enabled === false ? undefined : data.installed, isPending: false, isError: false };
  },
}));
vi.mock("@multica/core/plugins", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/plugins")>("@multica/core/plugins");
  return {
    pluginExtensionsFromSettings: actual.pluginExtensionsFromSettings,
    pluginInstallationsOptions: () => ({ queryKey: ["plugins"] }),
    pluginSurfaceLaunchOptions: () => ({ queryKey: ["surface"] }),
  };
});
vi.mock("../navigation", () => ({
  useNavigation: () => ({ push: vi.fn(), pathname: "/acme/issues" }),
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    pluginPage: (installationId: string, surfaceKey: string) => `/acme/plugins/${installationId}/${surfaceKey}`,
  }),
  useCurrentWorkspace: () => ({ id: "workspace-1", name: "Acme", slug: "acme", settings: data.settings }),
}));
vi.mock("@multica/core/config", () => ({ useFeatureEnabled: () => data.flagEnabled }));
vi.mock("../platform/local-directory", () => ({ isDesktopShell: () => false }));

import { PluginPagesSection, PluginWorkspacePage, collectWorkspacePages } from "./plugin-workspace-pages";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues, layout: enLayout } };

function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: "installation-1",
    plugin_key: "com.example.review",
    name: "Review",
    version: "1.0.0",
    package_version_id: "version-1",
    enabled: true,
    granted_scopes: ["issues:read"],
    config_schema: [],
    config: {},
    configured_secrets: [],
    surfaces: [
      { key: "board", type: "workspace_page", name: "Review board", entry: "ui/main.js", platforms: [] },
      { key: "panel", type: "issue_panel", name: "Panel", entry: "ui/main.js", platforms: [] },
    ],
    hooks: [],
    resources: [],
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("collectWorkspacePages", () => {
  it("keeps enabled workspace_page surfaces for this platform only", () => {
    const pages = collectWorkspacePages(
      [
        installation(),
        installation({ id: "off", enabled: false }),
        installation({
          id: "desktop-only",
          surfaces: [{ key: "d", type: "workspace_page", name: "D", entry: "ui/main.js", platforms: ["desktop"] }],
        }),
      ] as never,
      "web",
    );
    expect(pages.map(({ installation, surface }) => `${installation.id}:${surface.key}`)).toEqual(["installation-1:board"]);
  });
});

describe("PluginPagesSection", () => {
  beforeEach(() => {
    data.installed.plugins = [installation()];
    data.settings = {};
    data.flagEnabled = true;
    data.queried = [];
  });

  it("renders nothing and does not fetch while the workspace switch is off", () => {
    const { container } = render(<PluginPagesSection pathname="/acme/issues" />, { wrapper: Wrapper });
    expect(container).toBeEmptyDOMElement();
    expect(data.queried.every((enabled) => enabled === false)).toBe(true);
  });

  it("renders nothing while the Plugins flag is off, even with the switch on", () => {
    data.flagEnabled = false;
    data.settings = { plugin_extensions: { workspace_pages: true } };
    const { container } = render(<PluginPagesSection pathname="/acme/issues" />, { wrapper: Wrapper });
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each page and marks the open one", () => {
    data.settings = { plugin_extensions: { workspace_pages: true } };
    render(<PluginPagesSection pathname="/acme/plugins/installation-1/board" />, { wrapper: Wrapper });
    const link = screen.getByRole("link", { name: "Review board" });
    expect(link).toHaveAttribute("href", "/acme/plugins/installation-1/board");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("Panel")).not.toBeInTheDocument();
  });
});

describe("PluginWorkspacePage", () => {
  beforeEach(() => {
    data.installed.plugins = [installation()];
    data.flagEnabled = true;
    data.launch = null;
  });

  it("fills the page with the frame and leaves scrolling to the plugin", () => {
    data.settings = { plugin_extensions: { workspace_pages: true } };
    data.launch = { url: "https://plugin-content.example.test/plugin-surfaces/opaque", bridge_token: "proof" };
    render(<PluginWorkspacePage installationId="installation-1" surfaceKey="board" />, { wrapper: Wrapper });
    const frame = screen.getByTitle("Review — Review board");
    expect(frame).toHaveClass("flex-1");
    expect(frame.style.height).toBe("");
    expect(frame.parentElement).toHaveClass("h-full");
  });

  it("explains instead of mounting a frame when pages are off", () => {
    data.settings = {};
    render(<PluginWorkspacePage installationId="installation-1" surfaceKey="board" />, { wrapper: Wrapper });
    expect(screen.getByText(/This plugin page isn't available/)).toBeVisible();
  });

  it("mounts the page surface when it is listed", () => {
    data.settings = { plugin_extensions: { workspace_pages: true } };
    render(<PluginWorkspacePage installationId="installation-1" surfaceKey="board" />, { wrapper: Wrapper });
    expect(screen.getByRole("heading", { name: "Review board" })).toBeVisible();
    expect(screen.getByText("Loading Review…")).toBeVisible();
  });
});
