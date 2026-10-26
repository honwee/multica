export const NATIVE_AUTH_HANDOFF_PATH = "/auth/native";

/**
 * Navigate through the same-origin server instead of assigning a custom scheme
 * directly. ASWebAuthenticationSession reliably observes the resulting HTTP
 * redirect, while the token stays out of URLs, browser history and access logs.
 */
export function redirectToNativeAuth(token: string): void {
  const normalizedToken = token.trim();
  if (!normalizedToken) throw new Error("Missing native auth token");

  const form = document.createElement("form");
  form.method = "POST";
  form.action = NATIVE_AUTH_HANDOFF_PATH;
  form.style.display = "none";

  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "token";
  input.value = normalizedToken;
  form.append(input);
  document.body.append(form);
  form.submit();
}
