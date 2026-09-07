import { describe, expect, it } from "vitest";
import type { RemoteLoopbackTunnel } from "../../../shared/remoteLoopbackUrl";
import {
  reconcileTabTunnels,
  setTabTunnel,
  tunnelAwareUrl,
  TAB_TUNNEL_ARM_GRACE_MS,
  type TabTunnelMap,
} from "./browserRemoteTunnels";

const TUNNEL: RemoteLoopbackTunnel = {
  machineKey: "target-studio",
  machineLabel: "Mac Studio",
  remotePort: 3000,
  remoteOrigin: "http://localhost:3000",
  localPort: 52413,
  localOrigin: "http://127.0.0.1:52413",
};

const OTHER_TUNNEL: RemoteLoopbackTunnel = {
  ...TUNNEL,
  remotePort: 8080,
  remoteOrigin: "http://localhost:8080",
  localPort: 52999,
  localOrigin: "http://127.0.0.1:52999",
};

const NOW = 1_000_000;
const SETTLED = NOW + TAB_TUNNEL_ARM_GRACE_MS + 1;

function armed(tunnel: RemoteLoopbackTunnel = TUNNEL): TabTunnelMap {
  return { "tab-1": { tunnel, armedAt: NOW } };
}

describe("setTabTunnel", () => {
  it("records and replaces per tab, and ignores a missing tab id", () => {
    const withOne = setTabTunnel({}, "tab-1", TUNNEL, NOW);
    expect(withOne["tab-1"].tunnel.remotePort).toBe(3000);
    const replaced = setTabTunnel(withOne, "tab-1", OTHER_TUNNEL, NOW);
    expect(replaced["tab-1"].tunnel.remotePort).toBe(8080);
    expect(setTabTunnel(withOne, null, TUNNEL, NOW)).toBe(withOne);
    expect(setTabTunnel(withOne, "tab-1", null, NOW)).toEqual({});
  });
});

describe("reconcileTabTunnels", () => {
  it("keeps a tab that navigated within the forwarded origin", () => {
    const next = reconcileTabTunnels(
      armed(),
      [{ id: "tab-1", url: "http://127.0.0.1:52413/settings" }],
      SETTLED,
    );
    expect(next["tab-1"]).toBeTruthy();
  });

  it("drops a tab that left the tunnel for a real site", () => {
    const next = reconcileTabTunnels(
      armed(),
      [{ id: "tab-1", url: "https://example.test/" }],
      SETTLED,
    );
    expect(next["tab-1"]).toBeUndefined();
  });

  it("drops a tab that closed", () => {
    expect(reconcileTabTunnels(armed(), [], SETTLED)).toEqual({});
  });

  it("holds the mapping while the navigation is still in flight", () => {
    // The tab still reports the PREVIOUS page for a beat after `navigate`
    // resolves; dropping there would flash the raw forward port in the URL bar.
    const next = reconcileTabTunnels(
      armed(),
      [{ id: "tab-1", url: "https://example.test/" }],
      NOW + 10,
    );
    expect(next["tab-1"]).toBeTruthy();
  });

  it("keeps a tab that has not reported a URL yet", () => {
    const next = reconcileTabTunnels(armed(), [{ id: "tab-1", url: null }], SETTLED);
    expect(next["tab-1"]).toBeTruthy();
  });

  it("returns the same object when nothing changed, so React does not re-render", () => {
    const current = armed();
    expect(reconcileTabTunnels(
      current,
      [{ id: "tab-1", url: "http://127.0.0.1:52413/" }],
      SETTLED,
    )).toBe(current);
  });
});

describe("tunnelAwareUrl", () => {
  it("shows the remote origin for a tunneled tab and passes anything else through", () => {
    expect(tunnelAwareUrl("http://127.0.0.1:52413/a", { tunnel: TUNNEL, armedAt: NOW }))
      .toBe("http://localhost:3000/a");
    expect(tunnelAwareUrl("https://example.test/", null)).toBe("https://example.test/");
    // A stale mapping must never rewrite an unrelated page.
    expect(tunnelAwareUrl("https://example.test/", { tunnel: TUNNEL, armedAt: NOW }))
      .toBe("https://example.test/");
  });
});
