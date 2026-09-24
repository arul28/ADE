import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSourceFaviconService,
  extractFaviconCandidates,
  isInertSvg,
  normalizeFaviconHost,
  pickIcoEntry,
  sniffFaviconMime,
  SOURCE_FAVICON_LIMITS,
  type SourceFaviconFetch,
  type SourceFaviconFetchRequest,
  type SourceFaviconFetchResponse,
  type SourceFaviconLookup,
} from "./sourceFaviconService";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.from("ico-body")]);
const PUBLIC_IP = "93.184.216.34";

type Route = SourceFaviconFetchResponse | ((request: SourceFaviconFetchRequest) => Promise<SourceFaviconFetchResponse>);

function buildIco(frames: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.from([0, 0, 1, 0, frames.length, 0]);
  let offset = 6 + frames.length * 16;
  const entries = frames.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size;
    entry[1] = size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.data)]);
}

function page(html: string): SourceFaviconFetchResponse {
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(html) };
}
function image(body: Buffer, contentType = "image/png"): SourceFaviconFetchResponse {
  return { status: 200, headers: { "content-type": contentType }, body };
}
function redirect(location: string): SourceFaviconFetchResponse {
  return { status: 302, headers: { location }, body: Buffer.alloc(0) };
}
const notFound: SourceFaviconFetchResponse = { status: 404, headers: { "content-type": "text/html" }, body: Buffer.from("nope") };

function fakeNetwork(routes: Record<string, Route>, dns: Record<string, string[]> = {}) {
  const fetched: string[] = [];
  const pinned: string[] = [];
  const lookedUp: string[] = [];
  const lookup: SourceFaviconLookup = async (hostname) => {
    lookedUp.push(hostname);
    const answers = dns[hostname] ?? [PUBLIC_IP];
    if (!answers.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const fetch: SourceFaviconFetch = async (request) => {
    fetched.push(request.url.toString());
    pinned.push(request.address);
    const route = routes[request.url.toString()];
    if (!route) return notFound;
    const response = typeof route === "function" ? await route(request) : route;
    // Same contract as the real transport: stop at maxBytes and say so.
    return response.body.length > request.maxBytes
      ? { ...response, body: response.body.subarray(0, request.maxBytes), truncated: true }
      : response;
  };
  return { lookup, fetch, fetched, pinned, lookedUp };
}

let cacheDir: string;
const cacheFileFor = (host: string) => path.join(cacheDir, `${createHash("sha1").update(host).digest("hex")}.json`);
/** Lets real I/O (the disk-cache read) finish; bounded, never a timed wait. */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1_000 && !condition(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}
let clock: number;
const now = () => clock;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-favicons-"));
  clock = Date.UTC(2026, 8, 23);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe("extractFaviconCandidates", () => {
  it("prefers a ~32px icon, then SVG, then undeclared, then touch icons, resolved against the final page URL", () => {
    const html = `<html><head>
      <link rel="apple-touch-icon" href="/touch-180.png" sizes="180x180">
      <link rel="mask-icon" href="/mask.svg">
      <link rel="icon" href="/undeclared.ico">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="shortcut icon" href="static/icon-32.png" sizes="16x16 32x32">
      <link rel="icon" href="http://insecure.example/icon.png" sizes="32x32">
      <link rel="stylesheet" href="/app.css">
    </head><body><link rel="icon" href="/body-icon.png" sizes="32x32"></body></html>`;
    expect(extractFaviconCandidates(html, new URL("https://www.example.com/home/"))).toEqual([
      "https://www.example.com/home/static/icon-32.png",
      "https://www.example.com/icon.svg",
      "https://www.example.com/undeclared.ico",
      "https://www.example.com/touch-180.png",
    ]);
  });

  it("keeps inline data:image icons", () => {
    const html = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">`;
    expect(extractFaviconCandidates(html, new URL("https://a.dev/"))).toEqual([
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
    ]);
  });
});

describe("normalizeFaviconHost", () => {
  it("accepts public names and URLs, refuses local, private, loopback, link-local and single-label hosts", () => {
    expect(normalizeFaviconHost("Docs.Example.com")).toBe("docs.example.com");
    expect(normalizeFaviconHost("https://www.zed.dev/docs?x=1")).toBe("www.zed.dev");
    expect(normalizeFaviconHost("93.184.216.34")).toBe("93.184.216.34");
    for (const blocked of [
      "localhost", "api.localhost", "printer.local", "db.internal", "router", "127.0.0.1", "10.0.0.8",
      "192.168.1.1", "169.254.169.254", "172.16.4.2", "100.64.0.1", "[::1]", "http://[fe80::1]/",
      "file:///etc/passwd", "javascript:alert(1)", "", 42,
    ]) {
      expect(normalizeFaviconHost(blocked), String(blocked)).toBeNull();
    }
  });
});

describe("image validation", () => {
  it("sniffs real image bytes and refuses SVG with script, handlers, or foreign objects", () => {
    expect(sniffFaviconMime(PNG)).toBe("image/png");
    expect(sniffFaviconMime(ICO)).toBe("image/x-icon");
    expect(sniffFaviconMime(Buffer.from("<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"))).toBe("image/svg+xml");
    expect(sniffFaviconMime(Buffer.from("<!doctype html><html></html>"))).toBeNull();
    expect(isInertSvg("<svg><path d=\"M0 0\"/></svg>")).toBe(true);
    expect(isInertSvg("<svg><script>alert(1)</script></svg>")).toBe(false);
    expect(isInertSvg("<svg onload=\"alert(1)\"></svg>")).toBe(false);
    expect(isInertSvg("<svg><a href=\"javascript:alert(1)\"/></svg>")).toBe(false);
    expect(isInertSvg("<svg><foreignObject/></svg>")).toBe(false);
  });
});

describe("createSourceFaviconService", () => {
  it("does not retain or echo oversized domain keys in the remote response", async () => {
    const net = fakeNetwork({});
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    const oversized = `https://${"a".repeat(2_048)}`;
    const { icons } = await service.resolve({ domains: [oversized, "zed.dev"] });
    expect(Object.keys(icons)).toEqual(["zed.dev"]);
    expect(icons).toEqual({ "zed.dev": null });
  });

  it("resolves a declared icon to a data URL, pinning the vetted address", async () => {
    const net = fakeNetwork({
      "https://zed.dev/": redirect("https://www.zed.dev/"),
      "https://www.zed.dev/": page(`<head><link rel="icon" sizes="32x32" href="/icon-32.png"></head>`),
      "https://www.zed.dev/icon-32.png": image(PNG),
    });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    const { icons } = await service.resolve({ domains: ["zed.dev"] });
    expect(icons).toEqual({ "zed.dev": `data:image/png;base64,${PNG.toString("base64")}` });
    expect(net.fetched).toEqual(["https://zed.dev/", "https://www.zed.dev/", "https://www.zed.dev/icon-32.png"]);
    expect(new Set(net.pinned)).toEqual(new Set([PUBLIC_IP]));
  });

  it("falls back to /favicon.ico when the page declares no usable icon", async () => {
    const net = fakeNetwork({
      "https://plain.dev/": page(`<head><link rel="icon" href="/missing.png"></head>`),
      "https://plain.dev/favicon.ico": image(ICO, "image/vnd.microsoft.icon"),
    });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    expect(await service.resolveHost("plain.dev")).toBe(`data:image/x-icon;base64,${ICO.toString("base64")}`);
    expect(net.fetched).toEqual(["https://plain.dev/", "https://plain.dev/missing.png", "https://plain.dev/favicon.ico"]);
  });

  it("never connects to a host that resolves to a private address, even when only one answer is private", async () => {
    const net = fakeNetwork({}, {
      "internal.corp.dev": ["10.0.0.5"],
      "www.internal.corp.dev": ["10.0.0.5"],
      "mixed.dev": [PUBLIC_IP, "127.0.0.1"],
      "www.mixed.dev": [PUBLIC_IP, "127.0.0.1"],
    });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    const { icons } = await service.resolve({ domains: ["internal.corp.dev", "mixed.dev", "localhost", "192.168.0.1"] });
    expect(icons).toEqual({ "internal.corp.dev": null, "mixed.dev": null, localhost: null, "192.168.0.1": null });
    expect(net.fetched).toEqual([]);
    // Literal local hosts are refused before any DNS query.
    expect([...net.lookedUp].sort()).toEqual(["internal.corp.dev", "mixed.dev"]);
  });

  it("vets every redirect hop: a redirect to a private address or to http: is not followed", async () => {
    const net = fakeNetwork({
      "https://hop.dev/": redirect("https://metadata.hop.dev/latest"),
      "https://icon-hop.dev/": page(`<link rel="icon" sizes="32x32" href="/i.png">`),
      "https://icon-hop.dev/i.png": redirect("http://icon-hop.dev/i.png"),
      "https://icon-hop.dev/favicon.ico": redirect("https://127.0.0.1/favicon.ico"),
    }, { "metadata.hop.dev": ["169.254.169.254"] });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    expect(await service.resolveHost("hop.dev")).toBeNull();
    expect(await service.resolveHost("icon-hop.dev")).toBeNull();
    expect(net.fetched).toEqual([
      "https://hop.dev/",
      "https://icon-hop.dev/",
      "https://icon-hop.dev/i.png",
      "https://icon-hop.dev/favicon.ico",
    ]);
  });

  it("stops after three redirects", async () => {
    const net = fakeNetwork({
      "https://loop.dev/": page("<head></head>"),
      "https://loop.dev/favicon.ico": redirect("https://loop.dev/a"),
      "https://loop.dev/a": redirect("https://loop.dev/b"),
      "https://loop.dev/b": redirect("https://loop.dev/c"),
      "https://loop.dev/c": redirect("https://loop.dev/d"),
      "https://loop.dev/d": image(PNG),
    });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    expect(await service.resolveHost("loop.dev")).toBeNull();
    expect(net.fetched).not.toContain("https://loop.dev/d");
  });

  it("refuses oversized icons, non-image content types, and bytes that are not an image", async () => {
    const net = fakeNetwork({
      "https://limits.dev/": page(`<head>
        <link rel="icon" sizes="32x32" href="/huge.png">
        <link rel="icon" type="image/svg+xml" href="/typed-html.svg">
        <link rel="icon" href="/html-bytes.png">
      </head>`),
      "https://limits.dev/huge.png": image(Buffer.concat([PNG, Buffer.alloc(SOURCE_FAVICON_LIMITS.maxIconBytes)])),
      "https://limits.dev/typed-html.svg": image(PNG, "text/html"),
      "https://limits.dev/html-bytes.png": image(Buffer.from("<!doctype html>"), "image/png"),
      "https://limits.dev/favicon.ico": image(Buffer.from("<svg onload=\"alert(1)\"></svg>"), "image/svg+xml"),
    });
    const requests: SourceFaviconFetchRequest[] = [];
    const service = createSourceFaviconService({
      cacheDir,
      lookup: net.lookup,
      fetch: async (request) => {
        requests.push(request);
        return await net.fetch(request);
      },
      now,
    });
    expect(await service.resolveHost("limits.dev")).toBeNull();
    expect(requests.find((request) => request.url.pathname === "/huge.png")?.maxBytes).toBe(SOURCE_FAVICON_LIMITS.maxIconBytes);
    expect(requests[0]!.maxBytes).toBe(SOURCE_FAVICON_LIMITS.maxHtmlBytes);
  });

  it("keeps one ~32px frame of a multi-size ICO, even when the file is cut at 64 KB", async () => {
    const bmp32 = Buffer.alloc(4_264, 7);
    const ico = buildIco([
      { size: 16, data: Buffer.concat([PNG, Buffer.from("sixteen")]) },
      { size: 32, data: bmp32 },
      { size: 0, data: Buffer.alloc(150_000, 9) }, // 256px, far past the cap
    ]);
    const net = fakeNetwork({
      "https://bigico.dev/": page("<head></head>"),
      "https://bigico.dev/favicon.ico": image(ico, "image/x-icon"),
    });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    const dataUrl = await service.resolveHost("bigico.dev");
    const frame = Buffer.from(dataUrl!.replace("data:image/x-icon;base64,", ""), "base64");
    expect(frame.readUInt16LE(4)).toBe(1);
    expect(frame[6]).toBe(32);
    expect(frame.readUInt32LE(6 + 12)).toBe(22);
    expect(frame.subarray(22)).toEqual(bmp32);

    // A PNG frame comes back as PNG; a cut ICO with no complete frame is refused.
    expect(pickIcoEntry(buildIco([{ size: 32, data: PNG }]))).toEqual({ mime: "image/png", data: PNG });
    expect(pickIcoEntry(buildIco([{ size: 0, data: Buffer.alloc(100_000) }]).subarray(0, 65_536))).toBeNull();
  });

  it("times out a hung request after 3 s and remembers the failure only briefly, in memory", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let calls = 0;
    const net = fakeNetwork({
      "https://www.slow.dev/": (request) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        });
      },
    });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    const pending = service.resolveHost("www.slow.dev");
    await until(() => calls === 1);
    await vi.advanceTimersByTimeAsync(SOURCE_FAVICON_LIMITS.timeoutMs - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(fs.readdirSync(cacheDir)).toEqual([]);
    expect(await service.resolveHost("www.slow.dev")).toBeNull();
    expect(calls).toBe(1);
    clock += SOURCE_FAVICON_LIMITS.transientTtlMs + 1;
    const retry = service.resolveHost("www.slow.dev");
    await until(() => calls === 2);
    await vi.advanceTimersByTimeAsync(SOURCE_FAVICON_LIMITS.timeoutMs);
    expect(await retry).toBeNull();
  });

  it("tries the www. host when the apex does not resolve", async () => {
    const net = fakeNetwork({
      "https://www.apexless.dev/": page(`<link rel="icon" sizes="32x32" href="/i.png">`),
      "https://www.apexless.dev/i.png": image(PNG),
    }, { "apexless.dev": [] });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    expect(await service.resolveHost("apexless.dev")).toMatch(/^data:image\/png;base64,/);
  });

  it("dedupes concurrent requests and serves later ones from the disk cache, positive for 7 days", async () => {
    const net = fakeNetwork({
      "https://cached.dev/": page(`<link rel="icon" sizes="32x32" href="/i.png">`),
      "https://cached.dev/i.png": image(PNG),
    });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    const [first, second] = await Promise.all([service.resolveHost("cached.dev"), service.resolveHost("cached.dev")]);
    expect(first).toBe(second);
    expect(net.fetched).toHaveLength(2);

    // A fresh process (new service, same directory) reads the disk entry.
    const restarted = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    expect(await restarted.resolveHost("cached.dev")).toBe(first);
    expect(net.fetched).toHaveLength(2);

    clock += SOURCE_FAVICON_LIMITS.positiveTtlMs + 1;
    const expired = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    expect(await expired.resolveHost("cached.dev")).toBe(first);
    expect(net.fetched).toHaveLength(4);
  });

  it("caches 'no icon' for a day", async () => {
    const net = fakeNetwork({ "https://iconless.dev/": page("<head></head>") });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    expect(await service.resolveHost("iconless.dev")).toBeNull();
    const fetchedOnce = net.fetched.length;
    const restarted = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    expect(await restarted.resolveHost("iconless.dev")).toBeNull();
    expect(net.fetched).toHaveLength(fetchedOnce);
    clock += SOURCE_FAVICON_LIMITS.negativeTtlMs + 1;
    const nextDay = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    await nextDay.resolveHost("iconless.dev");
    expect(net.fetched.length).toBeGreaterThan(fetchedOnce);
  });

  it("caps the disk cache, removing the oldest entries first", async () => {
    const routes: Record<string, Route> = {};
    const hosts = ["one.dev", "two.dev", "three.dev", "four.dev"];
    for (const host of hosts) {
      routes[`https://${host}/`] = page(`<link rel="icon" sizes="32x32" href="/i.png">`);
      routes[`https://${host}/i.png`] = image(Buffer.concat([PNG, Buffer.alloc(600)]));
    }
    const net = fakeNetwork(routes);
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now, maxCacheBytes: 2_500 });
    for (const [index, host] of hosts.entries()) {
      await service.resolveHost(host);
      // Older entries get older mtimes, so "oldest first" is deterministic.
      const stamp = new Date(Date.UTC(2026, 0, 1) + index * 60_000);
      if (fs.existsSync(cacheFileFor(host))) fs.utimesSync(cacheFileFor(host), stamp, stamp);
    }
    const total = fs.readdirSync(cacheDir).reduce((sum, name) => sum + fs.statSync(path.join(cacheDir, name)).size, 0);
    expect(total).toBeLessThanOrEqual(2_500);
    expect(hosts.map((host) => fs.existsSync(cacheFileFor(host)))).toEqual([false, false, true, true]);
    const survivors = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    const before = net.fetched.length;
    await survivors.resolveHost("four.dev");
    expect(net.fetched.length).toBe(before);
  });

  it("accepts inline icons from the page after validating them", async () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>";
    const net = fakeNetwork({
      "https://inline.dev/": page(`<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}">`),
    });
    const service = createSourceFaviconService({ cacheDir, lookup: net.lookup, fetch: net.fetch, now });
    expect(await service.resolveHost("inline.dev")).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
    expect(net.fetched).toEqual(["https://inline.dev/"]);
  });
});
