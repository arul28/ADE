import { describe, expect, it } from "vitest";
import { buildDeeplink, type DeeplinkTarget } from "./deeplinks";
import { buildPairingQrPayload, parsePairingQrText } from "./pairingQr";
import type { SyncPairingConnectInfo } from "./types/sync";
import {
  WEB_CLIENT_BASE_URL,
  buildWebClientPairUrl,
  buildWebClientUrl,
} from "./webClientUrl";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

const targets: Array<{ name: string; target: DeeplinkTarget }> = [
  { name: "lane", target: { kind: "lane", laneId: UUID } },
  { name: "session", target: { kind: "session", sessionId: "session-123", laneId: UUID } },
  { name: "branch", target: { kind: "branch", repoOwner: "acme", repoName: "ade", branch: "users/me/web", prNumber: 42 } },
  { name: "pr", target: { kind: "pr", repoOwner: "acme", repoName: "ade", prNumber: 42 } },
  { name: "linear issue", target: { kind: "linear-issue", issueIdentifier: "ADE-123", branch: "users/me/web" } },
];

describe("buildWebClientUrl", () => {
  it.each(targets)("builds the hosted web URL for $name targets", ({ target }) => {
    const webUrl = new URL(buildWebClientUrl(target));
    const adeUrl = new URL(buildDeeplink(target, { form: "https" }));

    expect(webUrl.origin).toBe(WEB_CLIENT_BASE_URL);
    expect(webUrl.pathname).toBe(adeUrl.pathname);
    expect(webUrl.search).toBe(adeUrl.search);
    expect(webUrl.hash).toBe(adeUrl.hash);
  });

  it("preserves the /open path and query while swapping only the origin", () => {
    const webUrl = buildWebClientUrl({
      kind: "branch",
      repoOwner: "acme",
      repoName: "ade",
      branch: "feature/browser client",
      prNumber: 123,
    });

    expect(webUrl).toBe(
      "https://app.ade-app.dev/open?type=branch&repo=acme%2Fade&branch=feature%2Fbrowser+client&pr=123",
    );
  });
});

const connectInfo: SyncPairingConnectInfo = {
  hostIdentity: {
    deviceId: "device-123",
    siteId: "site-abc",
    name: "Arul's MacBook",
    platform: "macOS",
    deviceType: "desktop",
  },
  port: 8787,
  addressCandidates: [
    { host: "192.168.1.20", kind: "lan" },
    { host: "100.64.0.1", kind: "tailscale" },
  ],
};

describe("buildWebClientPairUrl", () => {
  it("builds a pair URL that the pairing parser accepts (QR wire encoding)", () => {
    const payload = buildPairingQrPayload({ connectInfo });
    const webUrl = new URL(buildWebClientPairUrl(payload));

    expect(webUrl.origin).toBe(WEB_CLIENT_BASE_URL);
    expect(webUrl.pathname).toBe("/pair");
    expect(webUrl.search).toBe("");
    expect(webUrl.hash.length).toBeGreaterThan(1);

    const parsed = parsePairingQrText(webUrl.toString());
    expect(parsed).not.toBeNull();
    expect(parsed?.hostIdentity).toEqual(connectInfo.hostIdentity);
    expect(parsed?.addressCandidates).toEqual(connectInfo.addressCandidates);
  });
});
