import { describe, expect, it } from "vitest";
import {
  browserHostLabel,
  browserUrlOrigin,
  clipboardUrlCandidate,
  completeBrowserUrl,
  hasHttpScheme,
  hasScheme,
  isLoopbackAuthority,
  looksLikeBareHost,
  splitBrowserUrlForDisplay,
  urlLockKind,
} from "./browserUrl";

describe("scheme and host predicates", () => {
  it("counts anything with a scheme as already addressed", () => {
    expect(hasScheme("https://example.com")).toBe(true);
    expect(hasScheme("ade://lane/1")).toBe(true);
    expect(hasScheme("mailto:hi@example.com")).toBe(true);
    expect(hasScheme("example.com")).toBe(false);
    // The reason `scheme: "http"` exists: a host:port reads as a scheme too.
    expect(hasScheme("localhost:3000")).toBe(true);
    expect(hasHttpScheme("localhost:3000")).toBe(false);
    expect(hasHttpScheme("HTTPS://example.com")).toBe(true);
  });

  it("recognises the three spellings of a dev server", () => {
    expect(isLoopbackAuthority("localhost:5173")).toBe(true);
    expect(isLoopbackAuthority("127.0.0.1:8080")).toBe(true);
    expect(isLoopbackAuthority("[::1]:3000")).toBe(true);
    expect(isLoopbackAuthority("192.168.1.5:3000")).toBe(false);
  });

  it("defaults to the loose rule the omnibox wants", () => {
    expect(looksLikeBareHost("example.com")).toBe(true);
    expect(looksLikeBareHost("fix the login page")).toBe(false);
    expect(looksLikeBareHost("release.notes.")).toBe(true);
    expect(looksLikeBareHost("release.notes.", "strict")).toBe(false);
  });
});

describe("completeBrowserUrl", () => {
  it("searches for prose when the caller is an omnibox", () => {
    expect(completeBrowserUrl("hello world", { fallback: "search" }))
      .toBe("https://www.google.com/search?q=hello%20world");
    expect(completeBrowserUrl("https://x.com", { fallback: "search" })).toBe("https://x.com");
  });

  it("hands a deeplink on untouched and completes a bare host for the link router", () => {
    expect(completeBrowserUrl("ade://lane/1", { fallback: "passthrough" })).toBe("ade://lane/1");
    // A dev server is not on TLS, so loopback completes to http.
    expect(completeBrowserUrl("127.0.0.1:8080", { fallback: "passthrough" }))
      .toBe("http://127.0.0.1:8080");
    expect(completeBrowserUrl("example.com", { fallback: "passthrough" }))
      .toBe("https://example.com");
  });

  it("offers nothing rather than a guess when the fallback is none", () => {
    expect(completeBrowserUrl("fix the login page", { fallback: "none" })).toBeNull();
    expect(completeBrowserUrl("", { fallback: "none" })).toBeNull();
    expect(completeBrowserUrl(null, { fallback: "search" })).toBeNull();
  });

  it("lets a non-http scheme fall through to the host rules when asked to", () => {
    expect(completeBrowserUrl("ftp://example.com/pub", { fallback: "none" }))
      .toBe("ftp://example.com/pub");
    expect(completeBrowserUrl("ftp://example.com/pub", { fallback: "none", scheme: "http" }))
      .toBeNull();
    expect(completeBrowserUrl("localhost:5173", { fallback: "none", scheme: "http" }))
      .toBe("http://localhost:5173");
    expect(completeBrowserUrl("http://localhost:5173", { fallback: "none", scheme: "http" }))
      .toBe("http://localhost:5173");
  });

  it("holds a string it was handed to a stricter host shape than one it was typed", () => {
    expect(completeBrowserUrl("release.notes.", { fallback: "none" }))
      .toBe("https://release.notes.");
    expect(completeBrowserUrl("release.notes.", { fallback: "none", hostRule: "strict" }))
      .toBeNull();
    expect(completeBrowserUrl("example.com", { fallback: "none", hostRule: "strict" }))
      .toBe("https://example.com");
  });

  it("trims before it decides", () => {
    expect(completeBrowserUrl("  example.com  ", { fallback: "none" })).toBe("https://example.com");
    expect(completeBrowserUrl("   ", { fallback: "search" })).toBeNull();
  });
});

describe("browserHostLabel", () => {
  it("drops the www prefix from a host", () => {
    expect(browserHostLabel("https://www.google.com/")).toBe("google.com");
    expect(browserHostLabel("not a url")).toBeNull();
  });

  it("keeps the prefix when a caller wants the literal host", () => {
    expect(browserHostLabel("https://www.google.com/", { stripWww: false })).toBe("www.google.com");
  });

  it("appends a path for a one-line status, but never a bare slash", () => {
    expect(browserHostLabel("https://www.example.com/docs/page", { includePath: true }))
      .toBe("example.com/docs/page");
    expect(browserHostLabel("https://example.com/", { includePath: true })).toBe("example.com");
  });

  it("can echo the raw string when there is nothing better to show", () => {
    expect(browserHostLabel("not a url", { fallbackToRaw: true })).toBe("not a url");
    expect(browserHostLabel("", { fallbackToRaw: true })).toBeNull();
    expect(browserHostLabel(null)).toBeNull();
  });
});

describe("splitBrowserUrlForDisplay", () => {
  it("emphasises the host and dims the rest", () => {
    expect(splitBrowserUrlForDisplay("https://www.example.com/docs/page?q=1#top"))
      .toEqual({ host: "example.com", rest: "/docs/page?q=1#top" });
    expect(splitBrowserUrlForDisplay("https://example.com/"))
      .toEqual({ host: "example.com", rest: "" });
  });

  it("declines anything that is not an http(s) address", () => {
    expect(splitBrowserUrlForDisplay("about:blank")).toBeNull();
    expect(splitBrowserUrlForDisplay("")).toBeNull();
    expect(splitBrowserUrlForDisplay("not a url")).toBeNull();
  });
});

describe("browserUrlOrigin", () => {
  it("is the origin of a real page", () => {
    expect(browserUrlOrigin("https://www.example.com/docs?q=1")).toBe("https://www.example.com");
    expect(browserUrlOrigin("http://localhost:5173/app")).toBe("http://localhost:5173");
  });

  it("is null for a blank tab and for anything that is not http", () => {
    expect(browserUrlOrigin("about:blank")).toBeNull();
    expect(browserUrlOrigin("mailto:hi@example.com")).toBeNull();
    expect(browserUrlOrigin("not a url")).toBeNull();
    expect(browserUrlOrigin("")).toBeNull();
    expect(browserUrlOrigin(null)).toBeNull();
  });
});

describe("urlLockKind", () => {
  it("marks https secure and every other http origin insecure", () => {
    expect(urlLockKind("https://example.test/")).toBe("secure");
    expect(urlLockKind("http://example.test/")).toBe("insecure");
    // Loopback is still plain http; calling it secure teaches the wrong reflex.
    expect(urlLockKind("http://localhost:3000")).toBe("insecure");
    expect(urlLockKind("")).toBe("none");
    expect(urlLockKind(null)).toBe("none");
  });

  it("shows no glyph at all for a scheme with no transport to describe", () => {
    expect(urlLockKind("about:blank")).toBe("none");
    expect(urlLockKind("ade://lane/1")).toBe("none");
  });
});

describe("clipboardUrlCandidate", () => {
  it("offers a link the clipboard actually holds", () => {
    expect(clipboardUrlCandidate("https://example.com/x")).toBe("https://example.com/x");
    expect(clipboardUrlCandidate(" localhost:5173 ")).toBe("http://localhost:5173");
    expect(clipboardUrlCandidate("example.com")).toBe("https://example.com");
  });

  it("stays quiet when the clipboard holds prose", () => {
    expect(clipboardUrlCandidate("fix the login page")).toBeNull();
    expect(clipboardUrlCandidate("")).toBeNull();
    expect(clipboardUrlCandidate(null)).toBeNull();
  });

  it("rejects anything with whitespace in it rather than guessing at the first token", () => {
    expect(clipboardUrlCandidate("https://example.com/x and more")).toBeNull();
    expect(clipboardUrlCandidate("example.com\nexample.org")).toBeNull();
  });

  it("does not scan a pasted file for a URL", () => {
    expect(clipboardUrlCandidate(`https://example.com/${"a".repeat(2_100)}`)).toBeNull();
  });
});
