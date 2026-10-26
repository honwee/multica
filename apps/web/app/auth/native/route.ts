import { resolveRemoteApiUrl } from "@/config/runtime-urls";

const MAX_TOKEN_LENGTH = 16_384;

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

function loginFailed(): Response {
  return redirect("multica://auth/callback?error=login_failed");
}

/**
 * Server-side iOS OAuth callback. The proxy preserves Feishu's registered
 * `/auth/callback` URI but rewrites mobile requests here. The bearer token is
 * created inside the backend exchange and only appears in the native scheme,
 * never in an HTTP URL, browser history or access log.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim() ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state.split(",").includes("platform:mobile")) {
    return loginFailed();
  }

  const apiBase = resolveRemoteApiUrl(process.env) ?? url.origin;
  const redirectUri = new URL("/auth/callback", url.origin).toString();

  try {
    const response = await fetch(`${apiBase}/auth/feishu`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as {
      token?: unknown;
    } | null;
    const token = typeof payload?.token === "string" ? payload.token.trim() : "";

    if (!response.ok || !token || token.length > MAX_TOKEN_LENGTH) {
      return loginFailed();
    }
    return redirect(
      `multica://auth/callback?token=${encodeURIComponent(token)}`,
    );
  } catch {
    return loginFailed();
  }
}
