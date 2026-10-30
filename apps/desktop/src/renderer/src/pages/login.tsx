import { LoginPage, LumistBrand } from "@multica/views/auth";
import { DragStrip } from "@multica/views/platform";
import { useConfigStore } from "@multica/core/config";
import lumistLogo from "../assets/lumist-logo.png";

function requireRuntimeAppUrl(): string {
  const runtimeConfig = window.desktopAPI.runtimeConfig;
  if (!runtimeConfig.ok) {
    throw new Error(
      "Invariant violated: DesktopLoginPage rendered before App accepted runtime config",
    );
  }
  return runtimeConfig.config.appUrl;
}

export function DesktopLoginPage() {
  const webUrl = requireRuntimeAppUrl();
  const feishuAppId = useConfigStore((state) => state.feishuAppId);
  const handleFeishuLogin = () => {
    if (!feishuAppId) return;
    const params = new URLSearchParams({
      client_id: feishuAppId,
      redirect_uri: `${webUrl}/auth/callback`,
      response_type: "code",
      state: "provider:feishu,platform:desktop",
    });
    window.desktopAPI.openExternal(
      `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${params}`,
    );
  };

  return (
    <div className="flex h-screen flex-col">
      <DragStrip />
      <LoginPage
        className="min-h-0 flex-1 bg-white px-6 py-12"
        cardClassName="max-w-md gap-6 rounded-none border-0 bg-transparent py-0 shadow-none"
        footerClassName="border-0 bg-transparent px-4 pb-0"
        logo={
          <LumistBrand
            logo={
              <img
                src={lumistLogo}
                alt="路觅教育"
                className="h-14 w-auto sm:h-16"
              />
            }
          />
        }
        onSuccess={() => {
          // Auth store update triggers AppContent re-render → shows DesktopShell.
          // Initial workspace navigation happens in routes.tsx via IndexRedirect.
        }}
        onFeishuLogin={feishuAppId ? handleFeishuLogin : undefined}
      />
    </div>
  );
}
