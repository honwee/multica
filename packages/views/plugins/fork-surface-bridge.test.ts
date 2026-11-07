import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCall = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/api", () => ({ api: { callPluginAction: mockCall } }));

import { createSurfaceBridge } from "./surface-bridge";

const TOKEN = "single-use-launch-proof";

function connected() {
  const bridge = createSurfaceBridge({ installationId: "installation-1", bridgeToken: TOKEN });
  const posted: Array<{ id?: string; ok?: boolean; status?: number }> = [];
  const frame = { contentWindow: {} } as unknown as HTMLIFrameElement;
  const channel = new MessageChannel();
  channel.port2.onmessage = (event) => {
    if ((event.data as { kind?: string } | null)?.kind !== "theme") posted.push(event.data);
  };
  channel.port2.start();
  bridge.connect(frame, {});
  const connect = new MessageEvent("message", { data: { type: "multica:plugin-bridge-connect", version: 2, challenge: TOKEN } });
  Object.defineProperty(connect, "source", { value: frame.contentWindow });
  Object.defineProperty(connect, "ports", { value: [channel.port1] });
  window.dispatchEvent(connect);
  return { bridge, port: channel.port2, posted };
}

describe("surface bridge — workspace page paths (fork)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCall.mockResolvedValue({ ok: true });
  });

  it("relays the workspace page endpoints", async () => {
    const { bridge, port, posted } = connected();
    const requests = [
      { id: "list", method: "GET", path: "/issues?status=in_review&limit=20" },
      { id: "comments", method: "POST", path: "/issue-batches/comments", body: { issue_ids: ["a"], content: "x" } },
      { id: "status", method: "POST", path: "/issue-batches/status", body: { issue_ids: ["a"], status: "done" } },
    ];
    for (const request of requests) port.postMessage({ kind: "action", ...request });
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(posted.every((message) => message.ok === true)).toBe(true);
    expect(mockCall.mock.calls.map(([, call]) => call.path)).toEqual(requests.map((request) => request.path));
    bridge.close();
  });

  it("still refuses paths outside the allowlist", async () => {
    const { bridge, port, posted } = connected();
    port.postMessage({ id: "other", kind: "action", method: "POST", path: "/issue-batches/delete" });
    port.postMessage({ id: "nested", kind: "action", method: "GET", path: "/issues/x/y" });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted.map((message) => message.status)).toEqual([400, 400]);
    expect(mockCall).not.toHaveBeenCalled();
    bridge.close();
  });
});
