import { describe, expect, it } from "vitest";
import {
  displayUrlForTunnel,
  isLoopbackHostname,
  loopbackOriginLabel,
  parseLoopbackUrl,
  remoteTunnelApprovalKey,
  rewriteUrlHostPort,
  urlBelongsToTunnel,
  type RemoteLoopbackTunnel,
} from "./remoteLoopbackUrl";

const TUNNEL: RemoteLoopbackTunnel = {
  machineKey: "target-studio",
  machineLabel: "Mac Studio",
  remotePort: 3000,
  remoteOrigin: "http://localhost:3000",
  localPort: 52413,
  localOrigin: "http://127.0.0.1:52413",
};

describe("isLoopbackHostname", () => {
  it("accepts every spelling a dev server prints", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "app.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "::1",
      "[::1]",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it("rejects real hosts, including ones that merely contain a loopback name", () => {
    for (const host of [
      "example.test",
      "localhost.evil.test",
      "127.0.0.1.evil.test",
      "10.0.0.1",
      "",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });
});

describe("parseLoopbackUrl", () => {
  it("reads the port from every loopback spelling", () => {
    expect(parseLoopbackUrl("http://localhost:3000/app")?.port).toBe(3000);
    expect(parseLoopbackUrl("http://127.0.0.1:5173/")?.port).toBe(5173);
    expect(parseLoopbackUrl("http://[::1]:8080/x?y=1")?.port).toBe(8080);
    expect(parseLoopbackUrl("http://0.0.0.0:4000")?.port).toBe(4000);
  });

  it("defaults the port from the scheme when none is given", () => {
    expect(parseLoopbackUrl("http://localhost/")?.port).toBe(80);
    expect(parseLoopbackUrl("https://localhost/")?.port).toBe(443);
  });

  it("passes through anything that is not an http(s) loopback URL", () => {
    expect(parseLoopbackUrl("https://example.test/app")).toBeNull();
    expect(parseLoopbackUrl("file:///tmp/index.html")).toBeNull();
    expect(parseLoopbackUrl("about:blank")).toBeNull();
    expect(parseLoopbackUrl("not a url")).toBeNull();
    expect(parseLoopbackUrl("")).toBeNull();
  });
});

describe("rewriteUrlHostPort", () => {
  it("keeps path, query and hash so a deep link survives the tunnel", () => {
    expect(rewriteUrlHostPort("http://localhost:3000/a/b?c=1#d", "127.0.0.1", 52413))
      .toBe("http://127.0.0.1:52413/a/b?c=1#d");
  });

  it("keeps the scheme: the forward is raw TCP either way", () => {
    expect(rewriteUrlHostPort("https://localhost:8443/", "127.0.0.1", 52413))
      .toBe("https://127.0.0.1:52413/");
  });
});

describe("tunnel display", () => {
  it("labels the origin the human asked for, not the forward port", () => {
    expect(displayUrlForTunnel("http://127.0.0.1:52413/dash?x=1", TUNNEL))
      .toBe("http://localhost:3000/dash?x=1");
  });

  it("refuses to relabel a page that left the tunnel", () => {
    expect(displayUrlForTunnel("https://example.test/", TUNNEL)).toBeNull();
    expect(displayUrlForTunnel("http://127.0.0.1:9999/", TUNNEL)).toBeNull();
    expect(urlBelongsToTunnel("http://127.0.0.1:52413/other", TUNNEL)).toBe(true);
    expect(urlBelongsToTunnel("https://example.test/", TUNNEL)).toBe(false);
  });

  it("builds the origin label from a parsed loopback URL", () => {
    const parsed = parseLoopbackUrl("http://localhost:3000/deep/path");
    expect(parsed && loopbackOriginLabel(parsed.url)).toBe("http://localhost:3000");
  });
});

describe("remoteTunnelApprovalKey", () => {
  it("separates ports on one machine and the same port on two machines", () => {
    expect(remoteTunnelApprovalKey("studio", 3000)).toBe("studio:3000");
    expect(remoteTunnelApprovalKey("studio", 3000))
      .not.toBe(remoteTunnelApprovalKey("studio", 8080));
    expect(remoteTunnelApprovalKey("studio", 3000))
      .not.toBe(remoteTunnelApprovalKey("laptop", 3000));
  });
});
