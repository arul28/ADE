import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_TARGETS,
  BRAIN_TARGETS,
  FALLBACK_CACHE_CONTROL,
  INSTALL_SCRIPTS,
  REDIRECT_CACHE_CONTROL,
  RELEASES_LATEST_PAGE,
  parseDownloadRequest,
  resolveStableRedirect,
  resolveVersionedRedirect,
  selectAssetUrl,
  stableAssetUrl,
} from "./releaseAssets.ts";
import {
  buildCapturePayload,
  captureMarketingEvent,
  captureUrlFromEnv,
  referrerHost,
} from "./marketingCapture.ts";

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

test("captureUrlFromEnv only accepts a public token over https", () => {
  assert.equal(captureUrlFromEnv({}), null);
  assert.equal(captureUrlFromEnv({ ADE_POSTHOG_PROJECT_TOKEN: "   " }), null);
  assert.equal(captureUrlFromEnv({ ADE_POSTHOG_PROJECT_TOKEN: "phx_personalkey123" }), null);
  assert.equal(
    captureUrlFromEnv({
      ADE_POSTHOG_PROJECT_TOKEN: "phc_abcdefgh12345678",
      ADE_POSTHOG_HOST: "http://us.i.posthog.com",
    }),
    null,
  );
  assert.equal(
    captureUrlFromEnv({
      ADE_POSTHOG_PROJECT_TOKEN: "phc_abcdefgh12345678",
      ADE_POSTHOG_HOST: "https://user:pass@us.i.posthog.com",
    }),
    null,
  );
  assert.equal(
    captureUrlFromEnv({ ADE_POSTHOG_PROJECT_TOKEN: "phc_abcdefgh12345678" }),
    "https://us.i.posthog.com/i/v0/e/",
  );
  assert.equal(
    captureUrlFromEnv({
      ADE_POSTHOG_PROJECT_TOKEN: "phc_abcdefgh12345678",
      ADE_POSTHOG_HOST: "https://ph.ade-app.dev/",
    }),
    "https://ph.ade-app.dev/i/v0/e/",
  );
});

test("captureMarketingEvent is a silent no-op when unconfigured", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await captureMarketingEvent({}, "ade_marketing_download_redirect", { artifact_kind: "x" });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("captureMarketingEvent swallows transport failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("posthog unreachable");
  }) as typeof fetch;
  try {
    await captureMarketingEvent(
      { ADE_POSTHOG_PROJECT_TOKEN: "phc_abcdefgh12345678" },
      "ade_marketing_download_redirect",
      { artifact_kind: "app_installer" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("capture payloads stay anonymous and match the browser client's shape", () => {
  const payload = buildCapturePayload(
    "phc_abcdefgh12345678",
    "ade_marketing_download_redirect",
    { artifact_kind: "app_installer", platform: "windows", arch: "x64" },
    "id-1",
  ) as { event: string; properties: Record<string, unknown> };
  assert.equal(payload.event, "ade_marketing_download_redirect");
  assert.equal(payload.properties.surface, "web");
  assert.equal(payload.properties.route_kind, "marketing");
  assert.equal(payload.properties.$process_person_profile, false);
  assert.equal(payload.properties.$geoip_disable, true);
  assert.equal(payload.properties.platform, "windows");
});

test("referrerHost keeps the host and drops everything else", () => {
  assert.equal(referrerHost(undefined), "direct");
  assert.equal(referrerHost(""), "direct");
  assert.equal(referrerHost("https://ade-app.dev/?utm_source=secret&email=a@b.c"), "ade-app.dev");
  assert.equal(referrerHost("https://news.ycombinator.com/item?id=1"), "news.ycombinator.com");
  assert.equal(referrerHost("nonsense"), "unknown");
});
