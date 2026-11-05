import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const translations = {
  desktop: {
    daemon: {
      settings_saved: "Saved",
      settings_save_failed: "Failed",
      workspace_allowlist_title: "Register runtimes in",
      workspace_allowlist_all: "All workspaces",
    },
  },
};

const workspaces = [
  { id: "ws-a", name: "Lumist" },
  { id: "ws-b", name: "教务FDE" },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: workspaces }),
}));
vi.mock("@multica/core/workspace", () => ({
  workspaceListOptions: () => ({ queryKey: ["workspaces", "list"] }),
}));
vi.mock("@multica/views/i18n", () => ({
  useT: () => ({
    t: (selector: (resources: typeof translations) => string) =>
      selector(translations),
  }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { DaemonWorkspaceAllowlist } from "./daemon-workspace-allowlist";

function stubDaemonAPI(allowlist: string[]) {
  const setWorkspaceAllowlist = vi.fn().mockResolvedValue({ success: true });
  Object.defineProperty(window, "daemonAPI", {
    configurable: true,
    value: {
      getWorkspaceAllowlist: vi.fn().mockResolvedValue(allowlist),
      setWorkspaceAllowlist,
    },
  });
  return setWorkspaceAllowlist;
}

describe("DaemonWorkspaceAllowlist", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders every workspace checked and says 'all' for an empty allowlist", async () => {
    stubDaemonAPI([]);
    render(<DaemonWorkspaceAllowlist />);

    expect(await screen.findByText("All workspaces")).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.getAttribute("aria-checked")).toBe("true");
    }
    expect(screen.getByText("Lumist")).toBeTruthy();
    expect(screen.getByText("教务FDE")).toBeTruthy();
  });

  it("unchecking a workspace saves the rest through IPC", async () => {
    const setAllowlist = stubDaemonAPI([]);
    render(<DaemonWorkspaceAllowlist />);

    await screen.findByText("All workspaces");
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);

    await waitFor(() => expect(setAllowlist).toHaveBeenCalledWith(["ws-a"]));
    await waitFor(() =>
      expect(screen.queryByText("All workspaces")).toBeNull(),
    );
  });

  it("checking the remaining workspace saves an empty list (all)", async () => {
    const setAllowlist = stubDaemonAPI(["ws-a"]);
    render(<DaemonWorkspaceAllowlist />);

    await screen.findByText("教务FDE");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[1]!.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(boxes[1]!);

    await waitFor(() => expect(setAllowlist).toHaveBeenCalledWith([]));
  });

  it("does not let the last checked workspace be cleared", async () => {
    stubDaemonAPI(["ws-a"]);
    render(<DaemonWorkspaceAllowlist />);

    await screen.findByText("Lumist");
    const [only] = screen.getAllByRole("checkbox");
    expect(only!.getAttribute("aria-checked")).toBe("true");
    expect(
      only!.hasAttribute("disabled") ||
        only!.getAttribute("aria-disabled") === "true" ||
        only!.hasAttribute("data-disabled"),
    ).toBe(true);
  });
});
