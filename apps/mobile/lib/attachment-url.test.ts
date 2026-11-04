/**
 * Pure-function tests for the mobile attachment URL resolver. The with-base
 * form covers URL joining directly; the bound form covers active-server reads.
 *
 * Coverage target: every branch the call sites in the app rely on —
 *   - `comment-attachment-list.tsx`         → file chip Linking.openURL
 *   - `markdown-image.tsx`                  → mc:// + RN image loader
 *   - `composer-attachment-row.tsx`         → completed non-image chip
 *                                             tap → Linking.openURL
 */
import { describe, expect, it } from "vitest";
import { useServerStore } from "@/data/server-store";
import {
  resolveAttachmentUrl,
  resolveAttachmentUrlWithBase,
} from "./attachment-url";

describe("resolveAttachmentUrlWithBase", () => {
  const BASE = "https://api.example.test";

  it("prepends the API base for a server-relative path", () => {
    expect(
      resolveAttachmentUrlWithBase("/api/attachments/att-1/download", BASE),
    ).toBe("https://api.example.test/api/attachments/att-1/download");
  });

  it("trims a trailing slash on the API base before joining", () => {
    expect(
      resolveAttachmentUrlWithBase(
        "/api/attachments/att-1/download",
        "https://api.example.test/",
      ),
    ).toBe("https://api.example.test/api/attachments/att-1/download");
  });

  it("passes an absolute https URL through unchanged (CloudFront / presigned)", () => {
    const signed =
      "https://cdn.example.test/att-1.bin?Policy=p&Signature=s&Key-Pair-Id=k";
    expect(resolveAttachmentUrlWithBase(signed, BASE)).toBe(signed);
  });

  it("passes an absolute http URL through unchanged (self-hosted dev)", () => {
    expect(
      resolveAttachmentUrlWithBase("http://localhost:8080/file.bin", BASE),
    ).toBe("http://localhost:8080/file.bin");
  });

  it("returns null for nullish or empty input", () => {
    expect(resolveAttachmentUrlWithBase(null, BASE)).toBeNull();
    expect(resolveAttachmentUrlWithBase(undefined, BASE)).toBeNull();
    expect(resolveAttachmentUrlWithBase("", BASE)).toBeNull();
  });

  it("keeps a relative path unchanged when the base is empty (web same-origin convention)", () => {
    // Mirrors `packages/core/workspace/avatar-url.ts` semantics for the
    // empty-base case — the host platform resolves the path against its
    // own document/page origin. RN doesn't have one, but exercising this
    // branch keeps the contract explicit.
    expect(
      resolveAttachmentUrlWithBase("/api/attachments/att-1/download", ""),
    ).toBe("/api/attachments/att-1/download");
  });
});

describe("composer file chip — completed non-image attachment", () => {
  // MUL-2976 (PR #3747 follow-up): when `api.uploadFile(...)` finishes on
  // a non-CloudFront deployment the returned `attachment.download_url` is
  // a server-relative path. `composer-attachment-row.tsx` taps that value
  // straight into `Linking.openURL` — and iOS rejects relative URLs with
  // "Cannot open URL". The fix wraps the value with `resolveAttachmentUrl`
  // before handing it to Linking; this test pins the behaviour we rely on.
  const BASE = "https://api.example.test";
  // Mirrors `ComposerAttachmentItem` after a successful non-image upload.
  const completedFileChip = {
    localId: "local-1",
    localUri: "file:///private/var/.../IMG_0001.pdf",
    filename: "report.pdf",
    mimeType: "application/pdf",
    status: "completed" as const,
    id: "att-42",
    url: "mc://file/att-42",
    downloadUrl: "/api/attachments/att-42/download",
  };

  it("resolves a server-relative downloadUrl against the API base", () => {
    expect(
      resolveAttachmentUrlWithBase(completedFileChip.downloadUrl, BASE),
    ).toBe("https://api.example.test/api/attachments/att-42/download");
  });

  it("preserves an absolute downloadUrl returned by CloudFront / presign", () => {
    const cloudFront = {
      ...completedFileChip,
      downloadUrl:
        "https://cdn.example.test/att-42.pdf?Signature=s&Key-Pair-Id=k",
    };
    expect(
      resolveAttachmentUrlWithBase(cloudFront.downloadUrl, BASE),
    ).toBe(cloudFront.downloadUrl);
  });

  it("returns null when the upload hasn't populated downloadUrl yet (no Linking call)", () => {
    // Mirrors a `completed` chip that arrived before the server response
    // (defensive; in practice `completed` implies downloadUrl is set).
    const partial = { ...completedFileChip, downloadUrl: undefined };
    expect(resolveAttachmentUrlWithBase(partial.downloadUrl, BASE)).toBeNull();
  });
});

describe("resolveAttachmentUrl (active server)", () => {
  it("reads the current server on every call", () => {
    useServerStore.setState({ apiUrl: "https://api.example.test" });
    expect(resolveAttachmentUrl("/api/attachments/one")).toBe(
      "https://api.example.test/api/attachments/one",
    );

    useServerStore.setState({ apiUrl: "https://self-hosted.example.test" });
    expect(resolveAttachmentUrl("/api/attachments/two")).toBe(
      "https://self-hosted.example.test/api/attachments/two",
    );
  });

  it("passes an absolute URL through regardless of the active server", () => {
    const absolute = "https://cdn.example.test/file.pdf?Signature=s";
    expect(resolveAttachmentUrl(absolute)).toBe(absolute);
  });

  it("returns null for empty input", () => {
    expect(resolveAttachmentUrl(undefined)).toBeNull();
    expect(resolveAttachmentUrl(null)).toBeNull();
    expect(resolveAttachmentUrl("")).toBeNull();
  });
});
