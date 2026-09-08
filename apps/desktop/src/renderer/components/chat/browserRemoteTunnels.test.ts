import { describe, expect, it } from "vitest";
import type { RemoteLoopbackTunnel } from "../../../shared/remoteLoopbackUrl";
import {
  commitTunnelApproval,
  reconcileTabTunnels,
  setTabTunnel,
  tunnelApprovalDecision,
  tunnelAwareUrl,
  TAB_TUNNEL_ARM_GRACE_MS,
  type TabTunnelMap,
  type TunnelApprovalState,
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

describe("tunnelApprovalDecision", () => {
  const KEY = "target-studio:3000";
  const empty: TunnelApprovalState = { sessionApproved: new Set<string>(), alwaysKeys: [] };

  it("lets a human-typed URL straight through: typing it IS the approval", () => {
    expect(tunnelApprovalDecision({ ...empty, key: KEY, human: true })).toBe("allow");
  });

  it("asks the first time an agent names a port, even on a trusted machine", () => {
    expect(tunnelApprovalDecision({ ...empty, key: KEY, human: false })).toBe("ask");
  });

  it("does not re-ask for a port already allowed once this session", () => {
    expect(tunnelApprovalDecision({
      sessionApproved: new Set([KEY]),
      alwaysKeys: [],
      key: KEY,
      human: false,
    })).toBe("allow");
  });

  it("honours a persisted always-grant across panes", () => {
    expect(tunnelApprovalDecision({
      sessionApproved: new Set<string>(),
      alwaysKeys: [KEY],
      key: KEY,
      human: false,
    })).toBe("allow");
  });

  it("scopes a grant to its own port, not to the machine", () => {
    // Approving a dev server on 3000 is not approving an admin console on 8080.
    expect(tunnelApprovalDecision({
      sessionApproved: new Set([KEY]),
      alwaysKeys: [KEY],
      key: "target-studio:8080",
      human: false,
    })).toBe("ask");
  });
});

describe("commitTunnelApproval", () => {
  const KEY = "target-studio:3000";
  const empty: TunnelApprovalState = { sessionApproved: new Set<string>(), alwaysKeys: [] };

  it("remembers 'once' for the session but writes nothing persistent", () => {
    const next = commitTunnelApproval(empty, KEY, "once");
    expect(next.sessionApproved.has(KEY)).toBe(true);
    expect(next.alwaysKeys).toEqual([]);
  });

  it("remembers 'always' in both places, so the next pane does not re-ask", () => {
    const next = commitTunnelApproval(empty, KEY, "always");
    expect(next.sessionApproved.has(KEY)).toBe(true);
    expect(next.alwaysKeys).toEqual([KEY]);
  });

  it("records nothing on a denial: refusing once is not a standing rule", () => {
    expect(commitTunnelApproval(empty, KEY, "deny")).toBe(empty);
  });

  it("returns the same state when the answer changes nothing", () => {
    const granted: TunnelApprovalState = { sessionApproved: new Set([KEY]), alwaysKeys: [KEY] };
    expect(commitTunnelApproval(granted, KEY, "always")).toBe(granted);
    expect(commitTunnelApproval(granted, KEY, "once")).toBe(granted);
  });
});
