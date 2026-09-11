/* @vitest-environment jsdom */

/**
 * The launchpad's recents store.
 *
 * Everything here is about what the list is allowed to KEEP: it is plaintext in
 * `localStorage`, its rows are rendered on the empty state, and it now carries
 * a second URL (the favicon) that the pane fetches. So the sanitizers get the
 * same treatment the page URL already had, and the title cleaner gets the cases
 * real sites actually produce.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  BROWSER_RECENT_FAVICON_MAX_BYTES,
  browserRecentUrlsKey,
  cleanBrowserRecentTitle,
  parseBrowserRecentUrls,
  readBrowserRecentUrls,
  rememberBrowserRecentUrl,
  sanitizeBrowserRecentFaviconUrl,
} from "./browserRecentUrls";

beforeEach(() => {
  window.localStorage.clear();
});

describe("sanitizeBrowserRecentFaviconUrl", () => {
  it("keeps http(s) icons, query and all", () => {
    // The cache-buster is the difference between the site's icon and a 404,
    // which is why this one keeps the query the page URL drops.
    expect(sanitizeBrowserRecentFaviconUrl("https://example.com/favicon.ico?v=3"))
      .toBe("https://example.com/favicon.ico?v=3");
    expect(sanitizeBrowserRecentFaviconUrl("http://localhost:5173/favicon.svg"))
      .toBe("http://localhost:5173/favicon.svg");
  });

  it("refuses anything that is not an image the renderer may load", () => {
    expect(sanitizeBrowserRecentFaviconUrl(null)).toBeNull();
    expect(sanitizeBrowserRecentFaviconUrl("   ")).toBeNull();
    expect(sanitizeBrowserRecentFaviconUrl("chrome-extension://abc/icon.png")).toBeNull();
    expect(sanitizeBrowserRecentFaviconUrl("file:///Users/me/icon.png")).toBeNull();
    expect(sanitizeBrowserRecentFaviconUrl("not a url")).toBeNull();
    // A data URL that is not an image is markup wearing an icon's name.
    expect(sanitizeBrowserRecentFaviconUrl("data:text/html,<script>x</script>")).toBeNull();
  });

  it("applies the page URL's own refusals", () => {
    // A credential in the icon's query is still a credential in the store.
    expect(sanitizeBrowserRecentFaviconUrl("https://example.com/i.png?access_token=abc")).toBeNull();
    // An ephemeral loopback port dies with the tunnel that forwarded it.
    expect(sanitizeBrowserRecentFaviconUrl("http://127.0.0.1:52413/favicon.ico")).toBeNull();
  });

  it("keeps small inline icons and drops fat ones", () => {
    const small = `data:image/png;base64,${"A".repeat(64)}`;
    expect(sanitizeBrowserRecentFaviconUrl(small)).toBe(small);
    const fat = `data:image/png;base64,${"A".repeat(BROWSER_RECENT_FAVICON_MAX_BYTES)}`;
    expect(sanitizeBrowserRecentFaviconUrl(fat)).toBeNull();
  });

  it("admits the largest icon main can inline", () => {
    // Main fetches at most 64KB of image bytes through the tab session and
    // republishes them as data, so the cap here has to clear that after base64
    // expansion or the launchpad would refuse exactly the icons it just gained.
    const inlined = `data:image/png;base64,${Buffer.alloc(64 * 1024, 1).toString("base64")}`;
    expect(sanitizeBrowserRecentFaviconUrl(inlined)).toBe(inlined);
  });
});

describe("cleanBrowserRecentTitle", () => {
  it("leaves a short title exactly as it is", () => {
    // Under the threshold the second segment is the disambiguating half.
    expect(cleanBrowserRecentTitle("Docs · ADE")).toBe("Docs · ADE");
    expect(cleanBrowserRecentTitle("  Vite + React  ")).toBe("Vite + React");
    expect(cleanBrowserRecentTitle(null)).toBeNull();
    expect(cleanBrowserRecentTitle("   ")).toBeNull();
  });

  it("takes the first segment of a long title, on any of the five separators", () => {
    expect(cleanBrowserRecentTitle("Pull requests · ade/ade · GitHub — where the world builds"))
      .toBe("Pull requests");
    expect(cleanBrowserRecentTitle("Dashboard overview and settings | Acme Analytics Platform"))
      .toBe("Dashboard overview and settings");
    expect(cleanBrowserRecentTitle("Getting started with the runtime — Acme Documentation Site"))
      .toBe("Getting started with the runtime");
    expect(cleanBrowserRecentTitle("Getting started with the runtime – Acme Documentation Site"))
      .toBe("Getting started with the runtime");
    expect(cleanBrowserRecentTitle("Getting started with the runtime - Acme Documentation Site"))
      .toBe("Getting started with the runtime");
  });

  it("cuts at the EARLIEST break, not the first separator it knows about", () => {
    expect(cleanBrowserRecentTitle("Issue 12 - ade/ade | GitHub, the home of open source software"))
      .toBe("Issue 12");
  });

  it("caps a title with no separator at 60 characters", () => {
    const long = "a".repeat(120);
    expect(cleanBrowserRecentTitle(long)).toHaveLength(60);
    // A leading separator is not a break — it would leave nothing behind.
    expect(cleanBrowserRecentTitle(` · ${"b".repeat(80)}`)).toHaveLength(60);
  });
});

describe("rememberBrowserRecentUrl", () => {
  it("stores the cleaned title and the sanitized favicon", () => {
    const entries = rememberBrowserRecentUrl("proj", {
      url: "https://example.com/issues/12?utm=x",
      title: "Issue 12: the thing is broken · example/repo · Examples",
      faviconUrl: "https://example.com/favicon.ico",
      visitedAt: 10,
    });
    expect(entries[0]).toEqual({
      url: "https://example.com/issues/12",
      title: "Issue 12: the thing is broken",
      faviconUrl: "https://example.com/favicon.ico",
      visitedAt: 10,
    });
    expect(readBrowserRecentUrls("proj")[0]?.faviconUrl).toBe("https://example.com/favicon.ico");
  });

  it("drops a favicon the gate refuses without dropping the row", () => {
    const entries = rememberBrowserRecentUrl("proj", {
      url: "https://example.com/",
      title: "Example",
      faviconUrl: "javascript:alert(1)",
      visitedAt: 10,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.faviconUrl).toBeNull();
  });
});

describe("parseBrowserRecentUrls", () => {
  it("re-sanitizes favicons written by an older build", () => {
    const raw = JSON.stringify([
      { url: "https://a.example/", title: "A", faviconUrl: "https://a.example/i.png", visitedAt: 2 },
      { url: "https://b.example/", title: "B", faviconUrl: "file:///etc/passwd", visitedAt: 1 },
      { url: "https://c.example/", title: "C", visitedAt: 0 },
    ]);
    const entries = parseBrowserRecentUrls(raw);
    expect(entries.map((entry) => entry.faviconUrl))
      .toEqual(["https://a.example/i.png", null, null]);
  });

  it("still scopes by key", () => {
    expect(browserRecentUrlsKey("proj")).not.toBe(browserRecentUrlsKey(null));
  });
});
