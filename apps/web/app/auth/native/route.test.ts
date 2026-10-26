import { describe, expect, it } from "vitest";
import { POST } from "./route";

function requestWithToken(token: string): Request {
  return new Request("https://multica.test/auth/native", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
}

describe("native auth handoff", () => {
  it("returns a no-store 303 redirect to the native callback", async () => {
    const response = await POST(requestWithToken("header.payload/with_symbols"));

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      "multica://auth/callback?token=header.payload%2Fwith_symbols",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects a missing token without redirecting", async () => {
    const response = await POST(requestWithToken(" "));

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
