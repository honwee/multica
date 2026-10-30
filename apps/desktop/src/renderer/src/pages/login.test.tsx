import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DesktopLoginPage } from "./login";

const mockOpenExternal = vi.hoisted(() => vi.fn());
const mockFeishuAppId = vi.hoisted(() => ({ value: "cli_test" }));
const APP_URL = "https://fde.lumistedu.com";

type LoginPageMockProps = {
  onGoogleLogin?: () => void;
  onFeishuLogin?: () => void;
};

vi.mock("@multica/core/config", () => ({
  useConfigStore: (selector: (state: { feishuAppId: string }) => unknown) =>
    selector({ feishuAppId: mockFeishuAppId.value }),
}));

vi.mock("@multica/views/auth", () => ({
  LoginPage: (props: LoginPageMockProps) => (
    <div>
      <button data-testid="google" onClick={props.onGoogleLogin}>
        Google
      </button>
      {props.onFeishuLogin ? (
        <button data-testid="feishu" onClick={props.onFeishuLogin}>
          Feishu
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("@multica/views/platform", () => ({
  DragStrip: () => <div />,
}));

vi.mock("@multica/ui/components/common/multica-icon", () => ({
  MulticaIcon: () => <div />,
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

  it("keeps the existing Google desktop handoff", () => {
    render(<DesktopLoginPage />);
    fireEvent.click(screen.getByTestId("google"));
    expect(mockOpenExternal).toHaveBeenCalledWith(
      `${APP_URL}/login?platform=desktop`,
    );
  });

  it("hides Feishu login when the backend has no app id", () => {
    mockFeishuAppId.value = "";
    render(<DesktopLoginPage />);
    expect(screen.queryByTestId("feishu")).not.toBeInTheDocument();
    expect(screen.getByTestId("google")).toBeInTheDocument();
  });
});
