/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chipFromMention, chipFromPath, chipFromSmartLink } from "../../../shared/chips";
import { deriveSmartLinkPreview } from "../../../shared/smartLinks";
import {
  chipPreviewUrl,
  requestChipPreview,
  resetChipPreviewCacheForTesting,
} from "./chipPreviewStore";

function chipForUrl(url: string) {
  const preview = deriveSmartLinkPreview(url);
  if (!preview) throw new Error(`not a link: ${url}`);
  return chipFromSmartLink(preview);
}

function installRuntime(resolveSmartLinkPreview: unknown): void {
  (window as unknown as { ade: unknown }).ade = { agentChat: { resolveSmartLinkPreview } };
}

describe("chipPreviewUrl", () => {
  it("only offers http(s) web pages and Linear issues", () => {
    expect(chipPreviewUrl(chipForUrl("https://example.com/post"))).toBe("https://example.com/post");
    expect(chipPreviewUrl(chipForUrl("https://linear.app/ade/issue/ADE-89/secrets")))
      .toBe("https://linear.app/ade/issue/ADE-89/secrets");
  });

  it("never offers a local or non-web chip", () => {
    // ade:// deeplinks, mentions, files and folders resolve locally; fetching
    // them would be a network call for data the app already has.
    expect(chipPreviewUrl(chipForUrl("ade://lane/25f280a4"))).toBeNull();
    expect(chipPreviewUrl(chipFromMention("chat", "abc123"))).toBeNull();
    expect(chipPreviewUrl(chipFromPath("src/app.ts"))).toBeNull();
    expect(chipPreviewUrl(chipFromPath("src/lib", { isDirectory: true }))).toBeNull();
    // A GitHub pill already reads owner/repo#123; its title belongs in the card.
    expect(chipPreviewUrl(chipForUrl("https://github.com/arul28/ADE/pull/835"))).toBeNull();
  });
});

describe("requestChipPreview", () => {
  beforeEach(() => {
    resetChipPreviewCacheForTesting();
  });

  afterEach(() => {
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("issues one request for concurrent askers and caches the answer", async () => {
    const deferred: { release?: (value: unknown) => void } = {};
    const resolveSmartLinkPreview = vi.fn(() => new Promise((resolve) => {
      deferred.release = resolve;
    }));
    installRuntime(resolveSmartLinkPreview);

    const first = requestChipPreview("https://example.com/post");
    const second = requestChipPreview("https://example.com/post");
    expect(resolveSmartLinkPreview).toHaveBeenCalledTimes(1);

    deferred.release?.({
      url: "https://example.com/post",
      provider: "generic",
      kind: "web_page",
      label: "https://example.com/post",
      title: "  Release  notes ",
      iconDataUrl: "data:image/png;base64,AAAB",
    });

    // Whitespace is collapsed the way the runtime's own `cleanTitle` does, so
    // the transcript and the composer print the same string.
    await expect(first).resolves.toEqual({ title: "Release notes", iconDataUrl: "data:image/png;base64,AAAB" });
    await expect(second).resolves.toEqual({ title: "Release notes", iconDataUrl: "data:image/png;base64,AAAB" });

    await requestChipPreview("https://example.com/post");
    expect(resolveSmartLinkPreview).toHaveBeenCalledTimes(1);
  });

  it("never throws, and never retries, when the runtime fails", async () => {
    const resolveSmartLinkPreview = vi.fn().mockRejectedValue(new Error("offline"));
    installRuntime(resolveSmartLinkPreview);

    await expect(requestChipPreview("https://example.com/down"))
      .resolves.toEqual({ title: null, iconDataUrl: null });
    await expect(requestChipPreview("https://example.com/down"))
      .resolves.toEqual({ title: null, iconDataUrl: null });
    expect(resolveSmartLinkPreview).toHaveBeenCalledTimes(1);
  });

  it("resolves empty when the runtime does not expose the route at all", async () => {
    (window as unknown as { ade: unknown }).ade = { agentChat: {} };
    await expect(requestChipPreview("https://example.com/missing"))
      .resolves.toEqual({ title: null, iconDataUrl: null });
  });

  it("drops an icon payload that is not an inline image", async () => {
    installRuntime(vi.fn().mockResolvedValue({
      url: "https://example.com/evil",
      provider: "generic",
      kind: "web_page",
      label: "https://example.com/evil",
      title: "Evil",
      iconDataUrl: "javascript:alert(1)",
    }));
    await expect(requestChipPreview("https://example.com/evil"))
      .resolves.toEqual({ title: "Evil", iconDataUrl: null });
  });
});
