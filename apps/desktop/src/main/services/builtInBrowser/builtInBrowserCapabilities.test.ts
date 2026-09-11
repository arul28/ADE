import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuiltInBrowserNetworkLogEntry } from "../../../shared/types";
import {
  BUILT_IN_BROWSER_EMULATION_PRESETS,
  findBuiltInBrowserEmulationPreset,
  resolveBuiltInBrowserEmulation,
} from "../../../shared/builtInBrowserEmulation";
import {
  BUILT_IN_BROWSER_REDACTED_HEADER_VALUE,
  buildBuiltInBrowserHar,
  builtInBrowserUploadRoots,
  clampBuiltInBrowserZoomFactor,
  createBuiltInBrowserNetworkLog,
  filterBuiltInBrowserNetworkLog,
  normalizeBuiltInBrowserRecordingFps,
  normalizeBuiltInBrowserHeaders,
  normalizeNetworkLogLimit,
  redactBuiltInBrowserUrl,
  resolveBuiltInBrowserUploadPaths,
} from "./builtInBrowserCapabilities";

function networkEntry(
  overrides: Partial<BuiltInBrowserNetworkLogEntry> = {},
): BuiltInBrowserNetworkLogEntry {
  return {
    id: "req-1",
    method: "GET",
    url: "https://example.test/api?page=2&q=hi",
    status: 200,
    statusText: "OK",
    mimeType: "application/json",
    resourceType: "XHR",
    protocol: "h2",
    fromCache: false,
    requestHeaders: [{ name: "Accept", value: "application/json", redacted: false }],
    responseHeaders: [{ name: "Content-Type", value: "application/json", redacted: false }],
    requestBodySize: null,
    responseBodySize: 128,
    responseHeaderSize: 64,
    timings: {
      startedAt: "2026-09-07T10:00:00.000Z",
      endedAt: "2026-09-07T10:00:00.250Z",
      durationMs: 250,
      waitMs: 200,
      receiveMs: 50,
    },
    error: null,
    ...overrides,
  };
}

describe("built-in browser emulation presets", () => {
  it("resolves preset ids and human labels to the same metrics", () => {
    const byId = resolveBuiltInBrowserEmulation({ preset: "iphone-17-pro" });
    const byLabel = resolveBuiltInBrowserEmulation({ preset: "iPhone 17 Pro" });
    expect(byId).toEqual(byLabel);
    expect(byId).toMatchObject({
      presetId: "iphone-17-pro",
      width: 402,
      height: 874,
      deviceScaleFactor: 3,
      mobile: true,
      hasTouch: true,
    });
    expect(byId?.userAgent).toContain("iPhone");
  });

  it("treats desktop, off and null as clearing the override", () => {
    expect(resolveBuiltInBrowserEmulation({ preset: "desktop" })).toBeNull();
    expect(resolveBuiltInBrowserEmulation({ preset: "off" })).toBeNull();
    expect(resolveBuiltInBrowserEmulation({ preset: null })).toBeNull();
    expect(resolveBuiltInBrowserEmulation({})).toBeNull();
  });

  it("rejects an unknown preset instead of silently staying on desktop", () => {
    expect(() => resolveBuiltInBrowserEmulation({ preset: "iphone-99" }))
      .toThrow(/Unknown browser device preset/);
  });

  it("builds a clamped responsive preset from a custom size", () => {
    const custom = resolveBuiltInBrowserEmulation({
      width: 900,
      height: 40,
      deviceScaleFactor: 99,
      mobile: true,
    });
    expect(custom).toMatchObject({
      presetId: "responsive",
      width: 900,
      height: 64,
      deviceScaleFactor: 5,
      mobile: true,
      hasTouch: true,
    });
    expect(custom?.label).toBe("900×64");
  });

  it("requires both dimensions for a custom size", () => {
    expect(() => resolveBuiltInBrowserEmulation({ width: 900 }))
      .toThrow(/both width and height/);
  });

  it("exposes every preset id exactly once", () => {
    const ids = BUILT_IN_BROWSER_EMULATION_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findBuiltInBrowserEmulationPreset("pixel")?.mobile).toBe(true);
    expect(findBuiltInBrowserEmulationPreset("nope")).toBeNull();
  });
});

describe("built-in browser zoom clamping", () => {
  it("clamps to the supported range and keeps in-range values", () => {
    expect(clampBuiltInBrowserZoomFactor(0.01)).toBe(0.25);
    expect(clampBuiltInBrowserZoomFactor(99)).toBe(5);
    expect(clampBuiltInBrowserZoomFactor(1.25)).toBe(1.25);
  });

  it("rejects non-finite factors", () => {
    expect(() => clampBuiltInBrowserZoomFactor(Number.NaN)).toThrow(/finite number/);
    expect(() => clampBuiltInBrowserZoomFactor("2" as unknown as number)).toThrow(/finite number/);
  });
});

describe("built-in browser network log", () => {
  it("redacts credential-bearing header values but keeps the names", () => {
    const headers = normalizeBuiltInBrowserHeaders({
      Authorization: "Bearer super-secret",
      cookie: "session=abc",
      "Set-Cookie": "session=abc; HttpOnly",
      "Proxy-Authorization": "Basic zzz",
      Accept: "text/html",
    });
    expect(headers).toEqual([
      { name: "Authorization", value: BUILT_IN_BROWSER_REDACTED_HEADER_VALUE, redacted: true },
      { name: "cookie", value: BUILT_IN_BROWSER_REDACTED_HEADER_VALUE, redacted: true },
      { name: "Set-Cookie", value: BUILT_IN_BROWSER_REDACTED_HEADER_VALUE, redacted: true },
      { name: "Proxy-Authorization", value: BUILT_IN_BROWSER_REDACTED_HEADER_VALUE, redacted: true },
      { name: "Accept", value: "text/html", redacted: false },
    ]);
    expect(JSON.stringify(headers)).not.toContain("super-secret");
    expect(JSON.stringify(headers)).not.toContain("session=abc");
  });

  it("keeps a bounded ring and counts what fell off", () => {
    const log = createBuiltInBrowserNetworkLog(3);
    for (let index = 0; index < 5; index += 1) {
      log.push(networkEntry({ id: `req-${index}` }));
    }
    expect(log.size).toBe(3);
    expect(log.droppedCount).toBe(2);
    expect(log.list().map((entry) => entry.id)).toEqual(["req-2", "req-3", "req-4"]);
  });

  it("upserts an in-flight entry in place rather than duplicating it", () => {
    const log = createBuiltInBrowserNetworkLog(10);
    log.upsert(networkEntry({ id: "req-a", status: null }));
    log.upsert(networkEntry({ id: "req-a", status: 404 }));
    expect(log.size).toBe(1);
    expect(log.find("req-a")?.status).toBe(404);
  });

  it("filters by substring and by failure", () => {
    const entries = [
      networkEntry({ id: "ok", url: "https://example.test/ok", status: 200 }),
      networkEntry({ id: "bad", url: "https://example.test/bad", status: 500 }),
      networkEntry({ id: "err", url: "https://other.test/x", status: null, error: "net::ERR" }),
    ];
    expect(filterBuiltInBrowserNetworkLog(entries, { failedOnly: true }).map((e) => e.id))
      .toEqual(["bad", "err"]);
    expect(filterBuiltInBrowserNetworkLog(entries, { filter: "other.test" }).map((e) => e.id))
      .toEqual(["err"]);
    expect(filterBuiltInBrowserNetworkLog(entries, {})).toHaveLength(3);
  });

  it("normalizes the read limit", () => {
    expect(normalizeNetworkLogLimit(undefined)).toBe(50);
    expect(normalizeNetworkLogLimit(0)).toBe(50);
    expect(normalizeNetworkLogLimit(5_000)).toBe(500);
    expect(normalizeNetworkLogLimit(12)).toBe(12);
  });
});

describe("built-in browser HAR export", () => {
  it("emits a HAR 1.2 log whose entries carry redacted headers and timings", () => {
    const har = buildBuiltInBrowserHar({
      entries: [
        networkEntry({
          requestHeaders: [
            { name: "Cookie", value: BUILT_IN_BROWSER_REDACTED_HEADER_VALUE, redacted: true },
          ],
        }),
      ],
      pageUrl: "https://example.test/",
      pageTitle: "Example",
      creatorVersion: "1.2.3",
      exportedAt: "2026-09-07T10:01:00.000Z",
    });
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator).toEqual({ name: "ADE built-in browser", version: "1.2.3" });
    expect(har.log.pages).toHaveLength(1);
    expect(har.log.pages[0]).toMatchObject({ id: "page_1", title: "Example" });
    const entry = har.log.entries[0] as Record<string, Record<string, unknown>>;
    expect(entry.pageref).toBe("page_1");
    expect(entry.time).toBe(250);
    expect(entry.request).toMatchObject({ method: "GET", httpVersion: "h2" });
    expect(entry.request.queryString).toEqual([
      { name: "page", value: "2" },
      { name: "q", value: "hi" },
    ]);
    expect(entry.request.headers).toEqual([
      { name: "Cookie", value: BUILT_IN_BROWSER_REDACTED_HEADER_VALUE },
    ]);
    expect(entry.response).toMatchObject({ status: 200, statusText: "OK" });
    expect(entry.timings).toEqual({ send: 0, wait: 200, receive: 50 });
  });

  it("degrades unknown sizes and timings to HAR's -1 sentinel", () => {
    const har = buildBuiltInBrowserHar({
      entries: [
        networkEntry({
          status: null,
          statusText: null,
          protocol: null,
          mimeType: null,
          responseBodySize: null,
          responseHeaderSize: null,
          timings: {
            startedAt: "2026-09-07T10:00:00.000Z",
            endedAt: null,
            durationMs: null,
            waitMs: null,
            receiveMs: null,
          },
          error: "net::ERR_FAILED",
        }),
      ],
      pageUrl: null,
      pageTitle: null,
      creatorVersion: "0.0.0",
      exportedAt: "2026-09-07T10:01:00.000Z",
    });
    const entry = har.log.entries[0] as Record<string, unknown>;
    expect(entry.time).toBe(-1);
    expect(entry.timings).toEqual({ send: 0, wait: -1, receive: -1 });
    expect(entry.comment).toBe("error: net::ERR_FAILED");
    expect((entry.response as Record<string, unknown>).status).toBe(0);
  });
});

describe("built-in browser upload roots", () => {
  let sandbox = "";
  let projectRoot = "";
  let observationRoot = "";

  beforeAll(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-upload-")));
    projectRoot = path.join(sandbox, "project");
    observationRoot = path.join(projectRoot, ".ade", "cache", "browser-observations");
    fs.mkdirSync(path.join(projectRoot, ".ade", "tmp"), { recursive: true });
    fs.mkdirSync(observationRoot, { recursive: true });
    fs.mkdirSync(path.join(sandbox, "secrets"), { recursive: true });
    fs.mkdirSync(path.join(sandbox, "ostmp"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "shot.png"), "shot");
    fs.writeFileSync(path.join(projectRoot, ".ade", "tmp", "a.txt"), "a");
    fs.writeFileSync(path.join(observationRoot, "obs.json"), "{}");
    fs.writeFileSync(path.join(sandbox, "secrets", "id_ed25519"), "PRIVATE KEY");
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // A private stand-in for `os.tmpdir()`: the real one contains the sandbox, so
  // using it would make every "outside the roots" case accidentally allowed.
  const roots = (): string[] => builtInBrowserUploadRoots({
    projectRoot,
    observationRoot,
    tmpDir: path.join(sandbox, "ostmp"),
  });

  it("accepts worktree, ADE scratch and observation-cache paths", () => {
    expect(resolveBuiltInBrowserUploadPaths([path.join(projectRoot, "shot.png")], roots()))
      .toEqual([path.join(projectRoot, "shot.png")]);
    expect(resolveBuiltInBrowserUploadPaths([path.join(projectRoot, ".ade", "tmp", "a.txt")], roots()))
      .toEqual([path.join(projectRoot, ".ade", "tmp", "a.txt")]);
    expect(resolveBuiltInBrowserUploadPaths([path.join(observationRoot, "obs.json")], roots()))
      .toEqual([path.join(observationRoot, "obs.json")]);
  });

  it("accepts a path that does not exist yet, leaving readability to the caller", () => {
    expect(resolveBuiltInBrowserUploadPaths([path.join(projectRoot, "later.png")], roots()))
      .toEqual([path.join(projectRoot, "later.png")]);
  });

  it("rejects paths outside every allowed root, including traversal escapes", () => {
    expect(() => resolveBuiltInBrowserUploadPaths([path.join(sandbox, "secrets", "id_ed25519")], roots()))
      .toThrow(/outside the allowed roots/);
    expect(() => resolveBuiltInBrowserUploadPaths([`${projectRoot}/../secrets/id_ed25519`], roots()))
      .toThrow(/outside the allowed roots/);
  });

  // Regression: a symlink an agent can write inside the project root used to
  // pass the lexical containment check and upload its target to the page.
  it("rejects a symlink inside an allowed root that points outside it", () => {
    const link = path.join(projectRoot, ".ade", "tmp", "report.txt");
    fs.symlinkSync(path.join(sandbox, "secrets", "id_ed25519"), link);
    try {
      expect(() => resolveBuiltInBrowserUploadPaths([link], roots()))
        .toThrow(/outside the allowed roots/);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("rejects empty lists, blank entries and null bytes", () => {
    expect(() => resolveBuiltInBrowserUploadPaths([], roots())).toThrow(/at least one file path/);
    expect(() => resolveBuiltInBrowserUploadPaths(["  "], roots())).toThrow(/non-empty strings/);
    expect(() => resolveBuiltInBrowserUploadPaths([`${projectRoot}/a\0b`], roots()))
      .toThrow(/null bytes/);
  });

  it("refuses everything when no root is configured", () => {
    expect(() => resolveBuiltInBrowserUploadPaths([path.join(projectRoot, "a.png")], []))
      .toThrow(/no allowed file root/);
  });
});

describe("built-in browser url redaction", () => {
  it("redacts credential-bearing query values and leaves the rest alone", () => {
    const redacted = new URL(
      redactBuiltInBrowserUrl("https://app.test/auth/callback?code=abc123&state=xyz&next=/home"),
    );
    expect(redacted.searchParams.get("code")).toBe(BUILT_IN_BROWSER_REDACTED_HEADER_VALUE);
    expect(redacted.searchParams.get("state")).toBe(BUILT_IN_BROWSER_REDACTED_HEADER_VALUE);
    expect(redacted.searchParams.get("next")).toBe("/home");
    expect(redactBuiltInBrowserUrl("https://app.test/api?page=2")).toBe("https://app.test/api?page=2");
    expect(redactBuiltInBrowserUrl("about:blank")).toBe("about:blank");
    expect(redactBuiltInBrowserUrl("not a url?token=secret")).toBe("not a url?token=secret");
  });
});

describe("built-in browser HAR query redaction", () => {
  it("replaces credential query values in the exported HAR", () => {
    const har = buildBuiltInBrowserHar({
      entries: [networkEntry({ url: "https://app.test/cb?code=abc123&page=2" })],
      pageUrl: "https://app.test/cb",
      pageTitle: "Callback",
      creatorVersion: "1.2.3",
      exportedAt: "2026-01-01T00:00:00.000Z",
    });
    const entry = har.log.entries[0] as { request: { queryString: Array<{ name: string; value: string }> } };
    expect(entry.request.queryString).toEqual([
      { name: "code", value: BUILT_IN_BROWSER_REDACTED_HEADER_VALUE },
      { name: "page", value: "2" },
    ]);
  });
});

describe("built-in browser recording fps", () => {
  it("accepts 30 and 60 and defaults to 30", () => {
    expect(normalizeBuiltInBrowserRecordingFps(undefined)).toBe(30);
    expect(normalizeBuiltInBrowserRecordingFps(null)).toBe(30);
    expect(normalizeBuiltInBrowserRecordingFps(60)).toBe(60);
  });

  it("rejects any other frame rate", () => {
    expect(() => normalizeBuiltInBrowserRecordingFps(24)).toThrow(/must be 30 or 60/);
    expect(() => normalizeBuiltInBrowserRecordingFps("60" as unknown as number))
      .toThrow(/must be 30 or 60/);
  });
});
