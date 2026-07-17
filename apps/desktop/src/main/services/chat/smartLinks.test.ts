import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveSmartLinkPreview,
  findSmartLinks,
  shouldReconcileSmartLinkDraft,
  smartLinkDisplayLabel,
  smartLinkProviderGlyph,
} from "../../../shared/smartLinks";
import {
  clearSmartLinkPreviewCacheForTesting,
  resolveSmartLinkPreview,
  smartLinkPreviewTesting,
} from "./smartLinkPreviewService";

function fakeIncomingMessage(headers: IncomingMessage["headers"] = {}): IncomingMessage & PassThrough {
  return Object.assign(new PassThrough(), { headers, statusCode: 200 }) as IncomingMessage & PassThrough;
}

describe("smart links", () => {
  beforeEach(() => clearSmartLinkPreviewCacheForTesting());

  it("derives compact catalogue labels while preserving canonical URLs", () => {
    const github = deriveSmartLinkPreview("https://github.com/arul28/ADE/pull/835");
    const linear = deriveSmartLinkPreview("https://linear.app/ade-linear/issue/ADE-89/live-release-secrets");
    const ade = deriveSmartLinkPreview("ade://lane/25f280a4");

    expect(github).toMatchObject({ provider: "github", kind: "github_pr", label: "arul28/ADE#835" });
    expect(linear).toMatchObject({ provider: "linear", kind: "linear_issue", label: "ADE-89" });
    expect(ade).toMatchObject({ provider: "ade", kind: "ade_deeplink", label: "ADE · lane/25f280a4" });
    expect(github?.url).toBe("https://github.com/arul28/ADE/pull/835");
  });

  it("trims prose punctuation and uses safe fallback presentation", () => {
    const matches = findSmartLinks("Review https://example.com/docs?q=1, then continue.");
    const generic = matches[0];

    expect(matches).toHaveLength(1);
    expect(generic?.url).toBe("https://example.com/docs?q=1");
    expect(generic ? smartLinkDisplayLabel(generic) : null).toBe("https://example.com/docs?q=1");
    expect(generic ? smartLinkProviderGlyph(generic.provider) : null).toBe("↗");
  });

  it("never shares authenticated provider titles through the process cache", async () => {
    const url = "https://github.com/private/repo/pull/7";
    const firstLookup = vi.fn(async () => ({ title: "Project A secret" }));
    const secondLookup = vi.fn(async () => ({ title: "Project B title" }));

    const first = await resolveSmartLinkPreview({ url, githubService: { getIssue: firstLookup } });
    const second = await resolveSmartLinkPreview({ url, githubService: { getIssue: secondLookup } });

    expect(first?.title).toBe("Project A secret");
    expect(second?.title).toBe("Project B title");
    expect(firstLookup).toHaveBeenCalledTimes(1);
    expect(secondLookup).toHaveBeenCalledTimes(1);
  });

  it("allows only globally routable IP addresses for generic previews", () => {
    expect(smartLinkPreviewTesting.isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(smartLinkPreviewTesting.isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
    expect(smartLinkPreviewTesting.isPublicIpAddress("169.254.169.254")).toBe(false);
    expect(smartLinkPreviewTesting.isPublicIpAddress("::ffff:a9fe:a9fe")).toBe(false);
    expect(smartLinkPreviewTesting.isPublicIpAddress("2002:a9fe:a9fe::1")).toBe(false);
    expect(smartLinkPreviewTesting.isPublicIpAddress("2001:db8::1")).toBe(false);
  });

  it("rejects declared and streamed responses that exceed the byte limit", async () => {
    const declared = fakeIncomingMessage({ "content-length": "11" });
    await expect(smartLinkPreviewTesting.readBoundedResponse(declared, 10)).rejects.toThrow("too large");

    const streamed = fakeIncomingMessage();
    const streamedResult = smartLinkPreviewTesting.readBoundedResponse(streamed, 10);
    streamed.write(Buffer.alloc(6));
    streamed.write(Buffer.alloc(6));
    await expect(streamedResult).rejects.toThrow("too large");
  });

  it("reconciles controlled clears without resetting local editor updates", () => {
    expect(shouldReconcileSmartLinkDraft("", "https://example.com", "https://example.com")).toBe(true);
    expect(shouldReconcileSmartLinkDraft("new prompt", "old prompt", "old prompt")).toBe(true);
    expect(shouldReconcileSmartLinkDraft("local edit", "local edit", "old prompt")).toBe(false);
    expect(shouldReconcileSmartLinkDraft("old prompt", "different dom", "old prompt")).toBe(false);
  });
});
