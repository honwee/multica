export const MULTICA_AUTH_CALLBACK_URL = "multica://auth/callback";

const FEISHU_AUTHORIZE_URL =
  "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
// The existing Web callback uses this marker for its native bearer-token handoff.
const FEISHU_NATIVE_HANDOFF_STATE = "provider:feishu,platform:desktop";

export class FeishuCallbackError extends Error {
  constructor() {
    super("Invalid Feishu callback");
    this.name = "FeishuCallbackError";
  }
}

export function resolveFeishuWebUrl(
  webUrl?: string,
  apiUrl?: string,
): string | null {
  const candidate = webUrl?.trim() || apiUrl?.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function buildFeishuAuthorizationUrl({
  appId,
  webUrl,
}: {
  appId: string;
  webUrl: string;
}): string {
  const clientId = appId.trim();
  const webOrigin = resolveFeishuWebUrl(webUrl);
  if (!clientId || !webOrigin) throw new Error("Feishu login is not configured");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: new URL("/auth/callback", webOrigin).toString(),
    response_type: "code",
    state: FEISHU_NATIVE_HANDOFF_STATE,
  });
  return `${FEISHU_AUTHORIZE_URL}?${params.toString()}`;
}

export function parseFeishuCallbackUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "multica:" ||
      url.hostname !== "auth" ||
      url.pathname !== "/callback"
    ) {
      throw new FeishuCallbackError();
    }

    const token = url.searchParams.get("token")?.trim();
    if (!token) throw new FeishuCallbackError();
    return token;
  } catch (error) {
    if (error instanceof FeishuCallbackError) throw error;
    throw new FeishuCallbackError();
  }
}
