import { QueryClient } from "@tanstack/react-query";
import { EMPTY_APP_CONFIG } from "@multica/core/api/schemas";
import type { AppConfigResponse } from "@multica/core/api/schemas";
import type { Comment, Issue, TimelineEntry } from "@multica/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/data/api";
import { appConfigOptions } from "@/data/queries/billing";
import { issueKeys } from "@/data/queries/issue-keys";
import {
  appendTimelineEntry,
  commentToTimelineEntry,
} from "@/data/realtime/issue-ws-updaters";
import { useFailedCommentsStore } from "@/data/stores/failed-comments-store";
import { useCreateComment, useDeleteComment } from "./issues";

const state = vi.hoisted(() => ({
  qc: undefined as unknown as QueryClient,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => state.qc,
    // Drive the hook's options through a real MutationObserver so the test
    // runs the same mutate → onSuccess → onSettled lifecycle as the app.
    useMutation: (
      options: ConstructorParameters<typeof actual.MutationObserver>[1],
    ) => {
      const observer = new actual.MutationObserver(state.qc, options);
      return { mutateAsync: (variables: unknown) => observer.mutate(variables) };
    },
  };
});

vi.mock("@/data/api", () => ({
  api: {
    createComment: vi.fn(),
    deleteComment: vi.fn(async () => undefined),
  },
}));

vi.mock("@/data/auth-store", () => ({
  useAuthStore: (
    selector: (s: { user: { id: string } }) => unknown,
  ) => selector({ user: { id: "user-1" } }),
}));

vi.mock("@/data/workspace-store", () => ({
  useWorkspaceStore: (
    selector: (s: { currentWorkspaceId: string }) => unknown,
  ) => selector({ currentWorkspaceId: "workspace-1" }),
}));

const wsId = "workspace-1";
const issueId = "issue-1";
const timelineKey = issueKeys.timeline(wsId, issueId);

function comment(id: string, parentId: string | null = null): TimelineEntry {
  return {
    type: "comment",
    id,
    actor_type: "member",
    actor_id: "user-1",
    created_at: "2026-09-11T07:00:00Z",
    content: `content of ${id}`,
    parent_id: parentId,
  };
}

// A thread whose root has a reply chain, plus an unrelated comment.
function seedThread() {
  state.qc.setQueryData<TimelineEntry[]>(timelineKey, [
    comment("comment-1"),
    comment("reply-1", "comment-1"),
    comment("reply-2", "reply-1"),
    comment("comment-2"),
  ]);
}

describe("useDeleteComment", () => {
  beforeEach(() => {
    state.qc = new QueryClient();
    vi.mocked(api.deleteComment).mockClear();
  });

  it("uses the keep-replies route and tombstones a comment with replies when the server declares it", async () => {
    state.qc.setQueryData(appConfigOptions().queryKey, {
      ...EMPTY_APP_CONFIG,
      comment_delete_keep_replies_supported: true,
    });
    seedThread();

    await useDeleteComment(issueId).mutateAsync("comment-1");

    expect(api.deleteComment).toHaveBeenCalledWith("comment-1", { keepReplies: true });
    const timeline = state.qc.getQueryData<TimelineEntry[]>(timelineKey);
    expect(timeline?.map((e) => e.id)).toEqual(["comment-1", "reply-1", "reply-2", "comment-2"]);
    expect(timeline?.[0]).toMatchObject({ content: "" });
    expect(timeline?.[0]?.deleted_at).toEqual(expect.any(String));
  });

  it.each<[string, AppConfigResponse | undefined]>([
    ["has not loaded", undefined],
    ["omits the capability", { cdn_domain: "", allow_signup: true }],
    ["declares it false", { ...EMPTY_APP_CONFIG, comment_delete_keep_replies_supported: false }],
  ])("uses the legacy route and drops every cached reply when the config %s", async (_label, config) => {
    if (config) state.qc.setQueryData(appConfigOptions().queryKey, config);
    seedThread();

    await useDeleteComment(issueId).mutateAsync("comment-1");

    expect(api.deleteComment).toHaveBeenCalledWith("comment-1", { keepReplies: false });
    expect(state.qc.getQueryData<TimelineEntry[]>(timelineKey)?.map((e) => e.id)).toEqual([
      "comment-2",
    ]);
  });

  it("refetches the owner issue projections because the 204 carries no issue_revision", async () => {
    const issue = { id: issueId, revision: 3 } as Issue;
    const myKey = issueKeys.myList(wsId, "assigned", { assignee_id: "user-1" });
    state.qc.setQueryData<Issue>(issueKeys.detail(wsId, issueId), issue);
    state.qc.setQueryData<Issue[]>(myKey, [issue]);
    state.qc.setQueryData<Issue[]>(issueKeys.list(wsId), [issue]);

    await useDeleteComment(issueId).mutateAsync("comment-1");

    for (const key of [issueKeys.detail(wsId, issueId), myKey, issueKeys.list(wsId)]) {
      expect(state.qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });
});

describe("useCreateComment reconciliation", () => {
  function serverComment(): Comment {
    return {
      id: "comment-new",
      issue_id: issueId,
      author_type: "member",
      author_id: "user-1",
      content: "hello",
      type: "comment",
      parent_id: null,
      reactions: [],
      attachments: [],
      created_at: "2026-09-11T07:01:00Z",
      updated_at: "2026-09-11T07:01:00Z",
      revision: 1,
      issue_revision: 4,
      resolved_at: null,
      resolved_by_type: null,
      resolved_by_id: null,
    };
  }

  beforeEach(() => {
    state.qc = new QueryClient();
    vi.mocked(api.createComment).mockReset();
    useFailedCommentsStore.setState({ failed: {} });
  });

  it("keeps exactly one real row when WS arrives before HTTP success", async () => {
    const server = serverComment();
    const response = Promise.withResolvers<Comment>();
    vi.mocked(api.createComment).mockReturnValue(response.promise);
    state.qc.setQueryData<TimelineEntry[]>(timelineKey, []);
    state.qc.setQueryData<Issue>(issueKeys.detail(wsId, issueId), {
      id: issueId,
      revision: 1,
    } as Issue);

    const pending = useCreateComment(issueId).mutateAsync({
      content: server.content,
      submissionId: "submission-1",
    });
    await vi.waitFor(() => {
      expect(state.qc.getQueryData<TimelineEntry[]>(timelineKey)?.map((e) => e.id)).toEqual([
        "optimistic-submission-1",
      ]);
    });

    useFailedCommentsStore.getState().markFailed("optimistic-submission-1", {
      content: server.content,
      submissionId: "submission-1",
      error: "stale failure",
    });
    appendTimelineEntry(state.qc, wsId, issueId, commentToTimelineEntry(server));
    expect(state.qc.getQueryData<TimelineEntry[]>(timelineKey)?.map((e) => e.id)).toEqual([
      server.id,
    ]);

    response.resolve(server);
    await pending;

    const timeline = state.qc.getQueryData<TimelineEntry[]>(timelineKey);
    expect(timeline).toHaveLength(1);
    expect(timeline?.[0]).toMatchObject({
      id: server.id,
      content: server.content,
      revision: 1,
    });
    expect(useFailedCommentsStore.getState().failed["optimistic-submission-1"]).toBeUndefined();
    expect(api.createComment).toHaveBeenCalledWith(issueId, server.content, {
      parentId: undefined,
      attachmentIds: undefined,
    });
    expect(state.qc.getQueryState(timelineKey)?.isInvalidated).toBe(true);
    expect(state.qc.getQueryState(issueKeys.detail(wsId, issueId))?.isInvalidated).toBe(true);
  });

  it("reuses the same optimistic row on retry without duplicates", async () => {
    const server = serverComment();
    const vars = { content: server.content, submissionId: "submission-retry" };
    const optimisticId = "optimistic-submission-retry";
    state.qc.setQueryData<TimelineEntry[]>(timelineKey, []);
    vi.mocked(api.createComment).mockRejectedValueOnce(new Error("offline"));

    await expect(useCreateComment(issueId).mutateAsync(vars)).rejects.toThrow("offline");

    expect(state.qc.getQueryData<TimelineEntry[]>(timelineKey)?.map((e) => e.id)).toEqual([
      optimisticId,
    ]);
    expect(useFailedCommentsStore.getState().failed[optimisticId]).toMatchObject({
      content: server.content,
      submissionId: vars.submissionId,
    });

    const response = Promise.withResolvers<Comment>();
    vi.mocked(api.createComment).mockReturnValueOnce(response.promise);
    const retry = useCreateComment(issueId).mutateAsync(vars);
    await vi.waitFor(() => {
      expect(state.qc.getQueryData<TimelineEntry[]>(timelineKey)?.map((e) => e.id)).toEqual([
        optimisticId,
      ]);
      expect(useFailedCommentsStore.getState().failed[optimisticId]).toBeUndefined();
    });

    response.resolve(server);
    await retry;

    expect(state.qc.getQueryData<TimelineEntry[]>(timelineKey)?.map((e) => e.id)).toEqual([
      server.id,
    ]);
    expect(useFailedCommentsStore.getState().failed[optimisticId]).toBeUndefined();
    expect(api.createComment).toHaveBeenCalledTimes(2);
  });
});
