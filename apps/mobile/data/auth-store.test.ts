// @vitest-environment node
import type { User } from "@multica/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAuthStore } from "./auth-store";

const apiMock = vi.hoisted(() => ({
  getToken: vi.fn(),
  setToken: vi.fn(),
  getMe: vi.fn(),
  sendCode: vi.fn(),
  verifyCode: vi.fn(),
}));

const storageMock = vi.hoisted(() => ({
  getToken: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
}));

const sessionMock = vi.hoisted(() => ({
  invalidateSessionEpoch: vi.fn(),
}));

const serverMock = vi.hoisted(() => ({
  initialize: vi.fn(),
}));

const workspaceMock = vi.hoisted(() => ({
  restoreSlug: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("./api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
}));

vi.mock("./secure-storage", () => storageMock);
vi.mock("./session-epoch", () => sessionMock);
vi.mock("./server-store", () => ({
  useServerStore: { getState: () => serverMock },
}));
vi.mock("./workspace-store", () => ({
  useWorkspaceStore: { getState: () => workspaceMock },
}));

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    name: "Feishu User",
    email: "ou_internal@feishu.invalid",
    avatar_url: null,
    onboarded_at: null,
    onboarding_questionnaire: {},
    language: null,
    profile_description: "",
    timezone: null,
    created_at: "2026-10-25T00:00:00Z",
    updated_at: "2026-10-25T00:00:00Z",
    ...overrides,
  };
}

describe("mobile auth store external token login", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useAuthStore.setState({ user: null, isLoading: false });
    apiMock.getToken.mockReturnValue(null);
    storageMock.setToken.mockResolvedValue(undefined);
  });

  it("validates and persists a Feishu internal-account session", async () => {
    const user = makeUser();
    apiMock.getMe.mockResolvedValue(user);

    await expect(
      useAuthStore.getState().loginWithToken("  feishu-jwt  "),
    ).resolves.toEqual(user);

    expect(sessionMock.invalidateSessionEpoch).toHaveBeenCalledTimes(1);
    expect(apiMock.setToken).toHaveBeenNthCalledWith(1, "feishu-jwt");
    expect(storageMock.setToken).toHaveBeenCalledWith("feishu-jwt");
    expect(apiMock.setToken).toHaveBeenLastCalledWith("feishu-jwt");
    expect(useAuthStore.getState().user).toEqual(user);
  });

  it("restores the previous API credential when token validation fails", async () => {
    apiMock.getToken.mockReturnValue("previous-jwt");
    apiMock.getMe.mockRejectedValue(new TypeError("Network request failed"));

    await expect(useAuthStore.getState().loginWithToken("new-jwt")).rejects.toThrow(
      "Network request failed",
    );

    expect(storageMock.setToken).not.toHaveBeenCalled();
    expect(apiMock.setToken).toHaveBeenLastCalledWith("previous-jwt");
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("rejects a fallback user instead of persisting an invalid session", async () => {
    apiMock.getToken.mockReturnValue("previous-jwt");
    apiMock.getMe.mockResolvedValue(makeUser({ id: "" }));

    await expect(useAuthStore.getState().loginWithToken("new-jwt")).rejects.toThrow(
      "Invalid authentication response",
    );

    expect(storageMock.setToken).not.toHaveBeenCalled();
    expect(apiMock.setToken).toHaveBeenLastCalledWith("previous-jwt");
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("ignores a blank deep-link token before changing session state", async () => {
    await expect(useAuthStore.getState().loginWithToken("  ")).rejects.toThrow(
      "Invalid authentication response",
    );

    expect(apiMock.getMe).not.toHaveBeenCalled();
    expect(apiMock.setToken).not.toHaveBeenCalled();
    expect(storageMock.setToken).not.toHaveBeenCalled();
    expect(sessionMock.invalidateSessionEpoch).not.toHaveBeenCalled();
  });
});

describe("mobile auth store email verification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useAuthStore.setState({ user: null, isLoading: false });
    storageMock.setToken.mockResolvedValue(undefined);
  });

  it("keeps the existing email-code login path", async () => {
    const user = makeUser({ email: "member@example.test" });
    apiMock.verifyCode.mockResolvedValue({ token: "email-jwt", user });

    await expect(
      useAuthStore.getState().verifyCode("member@example.test", "123456"),
    ).resolves.toEqual(user);

    expect(apiMock.verifyCode).toHaveBeenCalledWith("member@example.test", "123456");
    expect(storageMock.setToken).toHaveBeenCalledWith("email-jwt");
    expect(apiMock.setToken).toHaveBeenCalledWith("email-jwt");
    expect(useAuthStore.getState().user).toEqual(user);
  });

  it("does not persist a schema-fallback login response", async () => {
    apiMock.verifyCode.mockResolvedValue({
      token: "",
      user: makeUser({ id: "", email: "" }),
    });

    await expect(
      useAuthStore.getState().verifyCode("member@example.test", "123456"),
    ).rejects.toThrow("Invalid authentication response");

    expect(storageMock.setToken).not.toHaveBeenCalled();
    expect(apiMock.setToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user).toBeNull();
  });
});

describe("mobile auth cold-start restoration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useAuthStore.setState({ user: null, isLoading: true });
  });

  it("restores the server before the workspace and Keychain token", async () => {
    const order: string[] = [];
    serverMock.initialize.mockImplementation(async () => {
      order.push("server");
    });
    workspaceMock.restoreSlug.mockImplementation(async () => {
      order.push("workspace");
      return null;
    });
    storageMock.getToken.mockImplementation(async () => {
      order.push("token");
      return null;
    });

    await useAuthStore.getState().initialize();

    expect(order).toEqual(["server", "workspace", "token"]);
    expect(apiMock.setToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoading).toBe(false);
  });
});
