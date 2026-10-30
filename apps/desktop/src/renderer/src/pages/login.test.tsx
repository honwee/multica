import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { DesktopLoginPage } from "./login";

const mockOpenExternal = vi.hoisted(() => vi.fn());
const mockFeishuAppId = vi.hoisted(() => ({ value: "cli_test" }));
const APP_URL = "https://fde.lumistedu.com";

type LoginPageMockProps = {
  logo?: ReactNode;
  onGoogleLogin?: () => void;
  onFeishuLogin?: () => void;
};

vi.mock("@multica/core/config", () => ({
  useConfigStore: (selector: (state: { feishuAppId: string }) => unknown) =>
    selector({ feishuAppId: mockFeishuAppId.value }),
}));

vi.mock("@multica/views/auth", async () => {
  const actual = await vi.importActual<typeof import("@multica/views/auth")>(
    "@multica/views/auth",
  );
  return {
    ...actual,
    LoginPage: (props: LoginPageMockProps) => (
      <div>
        <div data-testid="brand">{props.logo}</div>
        {props.onGoogleLogin ? (
          <button data-testid="google" onClick={props.onGoogleLogin}>
            Google
          </button>
        ) : null}
        {props.onFeishuLogin ? (
          <button data-testid="feishu" onClick={props.onFeishuLogin}>
            Feishu
          </button>
        ) : null}
      </div>
    ),
  };
});

vi.mock("@multica/views/platform", () => ({
  DragStrip: () => <div />,
}));

vi.mock("@multica/ui/components/common/multica-icon", () => ({
  MulticaIcon: () => <span data-testid="multica-mark" />,
}));

describe("DesktopLoginPage", () => {
  beforeEach(() => {
    mockOpenExternal.mockReset();
    mockFeishuAppId.value = "cli_test";
    Object.defineProperty(window, "desktopAPI", {
      configurable: true,
      value: {
        runtimeConfig: { ok: true, config: { appUrl: APP_URL } },
        openExternal: mockOpenExternal,
      },
    });
  });

  it("opens Feishu OAuth externally with the desktop handoff state", () => {
    render(<DesktopLoginPage />);
    fireEvent.click(screen.getByTestId("feishu"));

    expect(mockOpenExternal).toHaveBeenCalledTimes(1);
    const target = new URL(mockOpenExternal.mock.calls[0][0] as string);
    expect(target.origin + target.pathname).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    expect(target.searchParams.get("client_id")).toBe("cli_test");
    expect(target.searchParams.get("redirect_uri")).toBe(
      `${APP_URL}/auth/callback`,
    );
    expect(target.searchParams.get("response_type")).toBe("code");
    expect(target.searchParams.get("state")).toBe(
      "provider:feishu,platform:desktop",
    );
  });

  it("does not offer Google login", () => {
    render(<DesktopLoginPage />);
    expect(screen.queryByTestId("google")).not.toBeInTheDocument();
  });

  it("hides Feishu login when the backend has no app id", () => {
    mockFeishuAppId.value = "";
    render(<DesktopLoginPage />);
    expect(screen.queryByTestId("feishu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("google")).not.toBeInTheDocument();
  });

  it("renders the shared Lumist and Multica branding", () => {
    render(<DesktopLoginPage />);
    expect(screen.getByTestId("brand")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "路觅教育" })).toBeInTheDocument();
    expect(screen.getByTestId("multica-mark")).toBeInTheDocument();
  });
});
