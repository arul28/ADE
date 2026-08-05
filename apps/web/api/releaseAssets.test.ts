import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_TARGETS,
  BRAIN_TARGETS,
  FALLBACK_CACHE_CONTROL,
  INSTALL_SCRIPTS,
  REDIRECT_CACHE_CONTROL,
  RELEASES_LATEST_PAGE,
  SCRIPT_CACHE_CONTROL,
  parseDownloadRequest,
  resolveStableRedirect,
  resolveVersionedRedirect,
  selectAssetUrl,
  stableAssetUrl,
  type VercelRes,
} from "./releaseAssets.ts";
import downloadHandler from "./download.ts";
import installHandler from "./install.ts";

const DOWNLOAD_PREFIX = "https://github.com/arul28/ADE/releases/download/v1.2.52";

/** Mirrors the real v1.2.52 asset list, blockmaps and zips included. */
function releasePayload() {
  return {
    assets: [
      "ADE-1.2.52-arm64.dmg",
      "ADE-1.2.52-arm64.zip",
      "ADE-1.2.52-win-x64.exe",
      "ADE-1.2.52-win-x64.exe.blockmap",
      "ADE-1.2.52-x64.dmg",
      "ADE-1.2.52-x64.zip",
      "ade-darwin-arm64",
      "ade-win32-x64.exe",
      "install.ps1",
      "install.sh",
      "latest-mac.yml",
      "SHA256SUMS",
    ].map((name) => ({ name, browser_download_url: `${DOWNLOAD_PREFIX}/${name}` })),
  };
}

test("selectAssetUrl picks the one asset matching each installer suffix", () => {
  const { assets } = releasePayload();
  assert.equal(
    selectAssetUrl(assets, APP_TARGETS["mac-arm64"]!.suffix),
    `${DOWNLOAD_PREFIX}/ADE-1.2.52-arm64.dmg`,
  );
  assert.equal(
    selectAssetUrl(assets, APP_TARGETS["mac-x64"]!.suffix),
    `${DOWNLOAD_PREFIX}/ADE-1.2.52-x64.dmg`,
  );
  assert.equal(
    selectAssetUrl(assets, APP_TARGETS.windows!.suffix),
    `${DOWNLOAD_PREFIX}/ADE-1.2.52-win-x64.exe`,
  );
});

test("selectAssetUrl never returns a blockmap, zip, or cross-arch asset", () => {
  const { assets } = releasePayload();
  for (const target of Object.values(APP_TARGETS)) {
    const url = selectAssetUrl(assets, target.suffix);
    assert.ok(url, `expected a match for ${target.suffix}`);
    assert.doesNotMatch(url!, /\.blockmap$/);
    assert.doesNotMatch(url!, /\.zip$/);
  }
  // The Apple Silicon DMG must not satisfy the Intel suffix, which is the one
  // way a suffix match could silently ship the wrong binary.
  assert.doesNotMatch("ADE-1.2.52-arm64.dmg", /-x64\.dmg$/);
});

test("selectAssetUrl rejects malformed payloads and off-repo URLs", () => {
  assert.equal(selectAssetUrl(undefined, "-arm64.dmg"), null);
  assert.equal(selectAssetUrl(null, "-arm64.dmg"), null);
  assert.equal(selectAssetUrl({ not: "an array" }, "-arm64.dmg"), null);
  assert.equal(selectAssetUrl([null, 7, "nope"], "-arm64.dmg"), null);
  assert.equal(selectAssetUrl([{ name: "ADE-9-arm64.dmg" }], "-arm64.dmg"), null);
  assert.equal(
    selectAssetUrl(
      [{ name: "ADE-9-arm64.dmg", browser_download_url: "https://evil.example/ADE-9-arm64.dmg" }],
      "-arm64.dmg",
    ),
    null,
  );
});

test("parseDownloadRequest maps every rewrite the site can produce", () => {
  assert.deepEqual(parseDownloadRequest({ kind: "app", slug: "mac-arm64" }), {
    kind: "app",
    slug: "mac-arm64",
    target: APP_TARGETS["mac-arm64"],
  });
  assert.deepEqual(parseDownloadRequest({ kind: "brain", target: "linux-x64" }), {
    kind: "brain",
    target: "linux-x64",
    asset: "ade-linux-x64",
    platform: "linux",
    arch: "x64",
  });
  assert.deepEqual(parseDownloadRequest({ kind: "script", script: "ps1" }), {
    kind: "script",
    script: "ps1",
    asset: "install.ps1",
    platform: "windows",
  });
});

test("parseDownloadRequest returns null for unknown or missing selectors", () => {
  assert.equal(parseDownloadRequest({}), null);
  assert.equal(parseDownloadRequest({ kind: "app" }), null);
  assert.equal(parseDownloadRequest({ kind: "app", slug: "mac-riscv" }), null);
  assert.equal(parseDownloadRequest({ kind: "brain", target: "solaris-sparc" }), null);
  assert.equal(parseDownloadRequest({ kind: "script", script: "bat" }), null);
  assert.equal(parseDownloadRequest({ kind: "elsewhere", slug: "mac-arm64" }), null);
  // Prototype keys must not resolve to Object.prototype members.
  assert.equal(parseDownloadRequest({ kind: "app", slug: "constructor" }), null);
  assert.equal(parseDownloadRequest({ kind: "brain", target: "__proto__" }), null);
});

test("all five brain targets and both install scripts are stable-named", () => {
  assert.deepEqual(Object.keys(BRAIN_TARGETS).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
  ]);
  for (const { asset } of Object.values(BRAIN_TARGETS)) {
    assert.equal(
      stableAssetUrl(asset),
      `https://github.com/arul28/ADE/releases/latest/download/${asset}`,
    );
  }
  assert.equal(INSTALL_SCRIPTS.sh!.asset, "install.sh");
  assert.equal(INSTALL_SCRIPTS.ps1!.asset, "install.ps1");
});

test("resolveStableRedirect never touches the network", () => {
  const redirect = resolveStableRedirect("ade-linux-arm64", REDIRECT_CACHE_CONTROL);
  assert.equal(
    redirect.location,
    "https://github.com/arul28/ADE/releases/latest/download/ade-linux-arm64",
  );
  assert.equal(redirect.resolved, true);
  assert.equal(redirect.cacheControl, REDIRECT_CACHE_CONTROL);
});

test("resolveVersionedRedirect resolves the installer from a live payload", async () => {
  const redirect = await resolveVersionedRedirect(APP_TARGETS.windows!, async () => releasePayload());
  assert.equal(redirect.location, `${DOWNLOAD_PREFIX}/ADE-1.2.52-win-x64.exe`);
  assert.equal(redirect.resolved, true);
  assert.equal(redirect.cacheControl, REDIRECT_CACHE_CONTROL);
});

test("resolveVersionedRedirect falls back to the releases page, uncached", async () => {
  const cases: Array<() => Promise<unknown>> = [
    // API down / timed out.
    async () => {
      throw new Error("boom");
    },
    // API reachable but the release has no matching asset (e.g. a Windows-less
    // release when ADE_WINDOWS_PUBLIC_RELEASE_ENABLED is off).
    async () => ({ assets: [{ name: "ADE-1.2.52-arm64.dmg", browser_download_url: `${DOWNLOAD_PREFIX}/ADE-1.2.52-arm64.dmg` }] }),
    // Garbage bodies.
    async () => null,
    async () => "not json",
    async () => ({}),
  ];
  for (const fetchRelease of cases) {
    const redirect = await resolveVersionedRedirect(APP_TARGETS.windows!, fetchRelease);
    assert.equal(redirect.location, RELEASES_LATEST_PAGE);
    assert.equal(redirect.resolved, false);
    assert.equal(redirect.cacheControl, FALLBACK_CACHE_CONTROL);
  }
});





type CapturedResponse = {
  res: VercelRes;
  headers: Record<string, string>;
  statusCode: number | null;
  body: string | undefined;
};

function captureResponse(): CapturedResponse {
  const captured: CapturedResponse = {
    headers: {},
    statusCode: null,
    body: undefined,
    res: undefined as unknown as VercelRes,
  };
  const res: VercelRes = {
    status(code) {
      captured.statusCode = code;
      return res;
    },
    setHeader(name, value) {
      captured.headers[name] = value;
    },
    end(body) {
      captured.body = body;
    },
  };
  captured.res = res;
  return captured;
}

/** Runs a handler with analytics configured and every capture POST counted. */
async function withCountedCaptures(
  run: () => Promise<void>,
): Promise<number> {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.ADE_POSTHOG_PROJECT_TOKEN;
  const originalHost = process.env.ADE_POSTHOG_HOST;
  let captures = 0;
  process.env.ADE_POSTHOG_PROJECT_TOKEN = "phc_abcdefgh12345678";
  delete process.env.ADE_POSTHOG_HOST;
  globalThis.fetch = (async () => {
    captures += 1;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.ADE_POSTHOG_PROJECT_TOKEN;
    else process.env.ADE_POSTHOG_PROJECT_TOKEN = originalToken;
    if (originalHost !== undefined) process.env.ADE_POSTHOG_HOST = originalHost;
  }
  return captures;
}

test("a write verb is refused before it can redirect or record a download", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const download = captureResponse();
    const install = captureResponse();
    const captures = await withCountedCaptures(async () => {
      await downloadHandler(
        { method, query: { kind: "brain", target: "linux-x64" }, headers: {} },
        download.res,
      );
      await installHandler({ method, query: { script: "sh" }, headers: {} }, install.res);
    });
    for (const answer of [download, install]) {
      assert.equal(answer.statusCode, 405);
      assert.equal(answer.headers.Allow, "GET, HEAD");
      assert.equal(answer.headers.Location, undefined);
      assert.equal(answer.headers["Cache-Control"], FALLBACK_CACHE_CONTROL);
    }
    assert.equal(captures, 0, `${method} must not reach analytics`);
  }
});

// docs/logging.md pins the public site to browser-only PostHog capture, so the
// redirect endpoints must never reach analytics for ANY method.
test("HEAD gets the same redirect as GET and neither reaches analytics", async () => {
  const headDownload = captureResponse();
  const getDownload = captureResponse();
  const headInstall = captureResponse();
  const getInstall = captureResponse();

  const headCaptures = await withCountedCaptures(async () => {
    await downloadHandler(
      { method: "HEAD", query: { kind: "brain", target: "linux-x64" }, headers: {} },
      headDownload.res,
    );
    await installHandler({ method: "HEAD", query: { script: "sh" }, headers: {} }, headInstall.res);
  });
  const getCaptures = await withCountedCaptures(async () => {
    await downloadHandler(
      { method: "GET", query: { kind: "brain", target: "linux-x64" }, headers: {} },
      getDownload.res,
    );
    await installHandler({ method: "GET", query: { script: "sh" }, headers: {} }, getInstall.res);
  });

  assert.equal(headCaptures, 0);
  assert.equal(getCaptures, 0);
  assert.deepEqual(headDownload.headers, getDownload.headers);
  assert.deepEqual(headInstall.headers, getInstall.headers);
  assert.equal(headDownload.statusCode, 302);
  assert.equal(headInstall.statusCode, 302);
  assert.equal(getDownload.headers.Location, stableAssetUrl("ade-linux-x64"));
  assert.equal(getDownload.headers["Cache-Control"], REDIRECT_CACHE_CONTROL);
  assert.equal(getDownload.headers["Referrer-Policy"], "no-referrer");
  assert.equal(getInstall.headers.Location, stableAssetUrl("install.sh"));
  assert.equal(getInstall.headers["Cache-Control"], SCRIPT_CACHE_CONTROL);
});

