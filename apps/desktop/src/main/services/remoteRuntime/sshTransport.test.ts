import fs from "node:fs";
import { createHmac } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import {
  buildSshConfig,
  buildSshConfigCandidates,
  buildSshRouteCandidates,
  buildSshUsernameCandidates,
  getSshHostKeyTrustForTarget,
  hasKnownSshHostKeyForTarget,
  parseOpenSshHostConfig,
  scanSshHostKeyForTarget,
  trustSshHostKeyForTarget,
  type ScannedSshHostKey,
} from "./sshTransport";

const target: RemoteRuntimeTarget = {
  id: "target-1",
  name: "Remote",
  hostname: "remote.example.test",
  sshUser: "ade",
  port: 22,
  sshKeyPath: null,
  lastSeenArch: null,
  runtimeBinaryVersion: null,
  lastConnectedAt: null,
};

const originalAgentSocket = process.env.SSH_AUTH_SOCK;

function createSshHomeWithKnownHosts(contents: string): {
  homeDir: string;
  knownHostsPath: string;
} {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-home-"));
  const sshDir = path.join(homeDir, ".ssh");
  fs.mkdirSync(sshDir, { recursive: true });
  const knownHostsPath = path.join(sshDir, "known_hosts");
  fs.writeFileSync(knownHostsPath, contents, "utf8");
  return { homeDir, knownHostsPath };
}

function expectHostVerifier(config: ReturnType<typeof buildSshConfig>): (key: Buffer) => boolean {
  expect(typeof config.hostVerifier).toBe("function");
  return config.hostVerifier as (key: Buffer) => boolean;
}

function scannedHostKey(args: {
  homeDir: string;
  key: Buffer;
  fingerprintSha256?: string;
}): ScannedSshHostKey {
  return {
    targetId: target.id,
    host: target.hostname,
    port: 22,
    route: {
      hostname: target.hostname,
      port: 22,
      source: "manual",
      lastSucceededAt: null,
    },
    key: args.key,
    keyType: "ssh-ed25519",
    fingerprintSha256: args.fingerprintSha256 ?? "SHA256:test-key",
    knownHostsPath: path.join(args.homeDir, ".ssh", "known_hosts"),
  };
}

afterEach(() => {
  if (originalAgentSocket === undefined) {
    delete process.env.SSH_AUTH_SOCK;
  } else {
    process.env.SSH_AUTH_SOCK = originalAgentSocket;
  }
});

describe("buildSshConfig", () => {
  it("uses the local ssh-agent socket when one is available", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/ade-agent.sock";

    expect(buildSshConfig(target, { sshConfigPath: null })).toMatchObject({
      host: "remote.example.test",
      port: 22,
      username: "ade",
      readyTimeout: 10_000,
      keepaliveInterval: 0,
      keepaliveCountMax: 3,
      agent: "/tmp/ade-agent.sock",
    });
  });

  it("resolves OpenSSH HostName and IdentityFile entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-config-"));
    const keyPath = path.join(dir, "id_ed25519");
    const configPath = path.join(dir, "config");
    fs.writeFileSync(keyPath, "PRIVATE KEY", "utf8");
    fs.writeFileSync(configPath, [
      "Host studio",
      "  HostName 192.168.1.42",
      `  IdentityFile ${keyPath}`,
      "",
      "Host *",
      "  IdentityFile ~/.ssh/fallback",
    ].join("\n"), "utf8");

    const config = buildSshConfig({ ...target, hostname: "studio" }, {
      env: {},
      sshConfigPath: configPath,
    });

    expect(config).toMatchObject({
      host: "192.168.1.42",
      port: 22,
      username: "ade",
      privateKey: Buffer.from("PRIVATE KEY"),
    });
  });

  it("falls back to the local username and default SSH port when target and SSH config omit them", () => {
    const config = buildSshConfig({
      ...target,
      hostname: "studio",
      sshUser: null,
      port: null,
    }, {
      env: {},
      sshConfigPath: null,
    });

    expect(config).toMatchObject({
      host: "studio",
      port: 22,
      username: os.userInfo().username,
    });
  });

  it("builds an admin retry candidate when no SSH user is configured", () => {
    expect(buildSshUsernameCandidates({
      ...target,
      hostname: "100.75.20.63",
      sshUser: null,
      port: null,
    }, {
      sshConfigPath: null,
    })).toEqual(Array.from(new Set([os.userInfo().username, "admin"])));
  });

  it("does not add username retries when SSH config provides a user", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-config-"));
    const configPath = path.join(dir, "config");
    fs.writeFileSync(configPath, [
      "Host studio",
      "  User remote-user",
    ].join("\n"), "utf8");

    expect(buildSshUsernameCandidates({
      ...target,
      hostname: "studio",
      sshUser: null,
      port: null,
    }, {
      sshConfigPath: configPath,
    })).toEqual(["remote-user"]);
  });

  it("builds retry configs with distinct SSH usernames", () => {
    const configs = buildSshConfigCandidates({
      ...target,
      hostname: "100.75.20.63",
      sshUser: null,
      port: null,
    }, {
      env: {},
      sshConfigPath: null,
    });

    expect(configs.map((config) => config.username)).toEqual(Array.from(new Set([os.userInfo().username, "admin"])));
    expect(configs.every((config) => config.host === "100.75.20.63" && config.port === 22)).toBe(true);
  });

  it("tries saved route fallbacks and prioritizes the last successful route", () => {
    const configs = buildSshConfigCandidates({
      ...target,
      hostname: "studio.tailnet.ts.net",
      sshUser: null,
      port: null,
      routes: [
        {
          hostname: "192.168.1.42",
          port: null,
          source: "bonjour",
          lastSucceededAt: 200,
        },
        {
          hostname: "studio.tailnet.ts.net",
          port: null,
          source: "tailscale",
          lastSucceededAt: 100,
        },
      ],
    }, {
      env: {},
      sshConfigPath: null,
    });

    const usernames = Array.from(new Set([os.userInfo().username, "admin"]));
    expect(configs.map((config) => config.host)).toEqual([
      ...usernames.map(() => "192.168.1.42"),
      ...usernames.map(() => "studio.tailnet.ts.net"),
    ]);
    expect(buildSshRouteCandidates({
      ...target,
      hostname: "studio.tailnet.ts.net",
      routes: [
        {
          hostname: "192.168.1.42",
          port: null,
          source: "bonjour",
          lastSucceededAt: 200,
        },
      ],
    }).map((route) => route.hostname)).toEqual([
      "192.168.1.42",
      "studio.tailnet.ts.net",
    ]);
  });

  it("uses the first readable OpenSSH default identity when no explicit key is configured", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-home-"));
    const sshDir = path.join(homeDir, ".ssh");
    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(path.join(sshDir, "id_ed25519"), "DEFAULT PRIVATE KEY", "utf8");

    const config = buildSshConfig(target, {
      env: {},
      homeDir,
      sshConfigPath: null,
    });

    expect(config).toMatchObject({
      privateKey: Buffer.from("DEFAULT PRIVATE KEY"),
    });
  });

  it("uses OpenSSH User and Port entries from matching aliases", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-config-"));
    const configPath = path.join(dir, "config");
    fs.writeFileSync(configPath, [
      "Host studio",
      "  HostName 192.168.1.42",
      "  User remote-user",
      "  Port 2200",
    ].join("\n"), "utf8");

    const config = buildSshConfig({
      ...target,
      hostname: "studio",
      sshUser: null,
      port: null,
    }, {
      env: {},
      sshConfigPath: configPath,
    });

    expect(config).toMatchObject({
      host: "192.168.1.42",
      port: 2200,
      username: "remote-user",
    });
  });

  it("reads OpenSSH config from the provided home directory", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-home-"));
    const sshDir = path.join(homeDir, ".ssh");
    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(path.join(sshDir, "config"), [
      "Host studio",
      "  HostName 192.168.1.42",
      "  User remote-user",
    ].join("\n"), "utf8");

    const config = buildSshConfig({
      ...target,
      hostname: "studio",
      sshUser: null,
    }, {
      env: {},
      homeDir,
    });

    expect(config).toMatchObject({
      host: "192.168.1.42",
      username: "remote-user",
    });
  });

  it("honors UserKnownHostsFile from OpenSSH config", () => {
    const hostKey = Buffer.from("remote host key");
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-home-"));
    const sshDir = path.join(homeDir, ".ssh");
    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(path.join(sshDir, "custom_known_hosts"), [
      `192.168.1.42 ssh-ed25519 ${hostKey.toString("base64")}`,
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(sshDir, "config"), [
      "Host studio",
      "  HostName 192.168.1.42",
      "  UserKnownHostsFile ~/.ssh/custom_known_hosts",
    ].join("\n"), "utf8");

    const config = buildSshConfig({
      ...target,
      hostname: "studio",
    }, {
      env: {},
      homeDir,
    });

    expect(expectHostVerifier(config)(hostKey)).toBe(true);
    expect(hasKnownSshHostKeyForTarget({
      ...target,
      hostname: "studio",
    }, {
      homeDir,
    })).toBe(true);
  });

  it("verifies SSH host keys against OpenSSH known_hosts", () => {
    const hostKey = Buffer.from("remote host key");
    const { homeDir, knownHostsPath } = createSshHomeWithKnownHosts(
      `remote.example.test ssh-ed25519 ${hostKey.toString("base64")}\n`,
    );

    const config = buildSshConfig(target, {
      env: {},
      homeDir,
      knownHostsPath,
      sshConfigPath: null,
    });

    const verifier = expectHostVerifier(config);
    expect(verifier(hostKey)).toBe(true);
    expect(verifier(Buffer.from("other key"))).toBe(false);
    expect(hasKnownSshHostKeyForTarget(target, {
      homeDir,
      knownHostsPath,
      sshConfigPath: null,
    })).toBe(true);
  });

  it("matches bracketed known_hosts entries for non-standard ports", () => {
    const hostKey = Buffer.from("remote host key");
    const { homeDir, knownHostsPath } = createSshHomeWithKnownHosts(
      `[remote.example.test]:2200 ssh-ed25519 ${hostKey.toString("base64")}\n`,
    );

    const config = buildSshConfig({ ...target, port: 2200 }, {
      env: {},
      homeDir,
      knownHostsPath,
      sshConfigPath: null,
    });

    expect(expectHostVerifier(config)(hostKey)).toBe(true);
  });

  it("matches hashed OpenSSH known_hosts entries", () => {
    const hostKey = Buffer.from("remote host key");
    const salt = Buffer.from("ade-salt");
    const hashedHost = createHmac("sha1", salt)
      .update("remote.example.test")
      .digest("base64");
    const { homeDir, knownHostsPath } = createSshHomeWithKnownHosts(
      `|1|${salt.toString("base64")}|${hashedHost} ssh-ed25519 ${hostKey.toString("base64")}\n`,
    );

    const config = buildSshConfig(target, {
      env: {},
      homeDir,
      knownHostsPath,
      sshConfigPath: null,
    });

    expect(expectHostVerifier(config)(hostKey)).toBe(true);
  });

  it("reports an untrusted scanned SSH host key for first-time trust", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-home-"));
    const key = Buffer.from("remote host key");

    await expect(getSshHostKeyTrustForTarget(target, {
      env: {},
      homeDir,
      sshConfigPath: null,
      scanHostKey: async () => scannedHostKey({ homeDir, key }),
    })).resolves.toMatchObject({
      state: "needs_trust",
      targetId: target.id,
      host: target.hostname,
      fingerprintSha256: "SHA256:test-key",
    });
  });

  it("records a trusted SSH host key in known_hosts", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-home-"));
    const key = Buffer.from("remote host key");

    await trustSshHostKeyForTarget(target, "SHA256:test-key", {
      env: {},
      homeDir,
      sshConfigPath: null,
      scanHostKey: async () => scannedHostKey({ homeDir, key }),
    });

    const knownHostsPath = path.join(homeDir, ".ssh", "known_hosts");
    expect(fs.readFileSync(knownHostsPath, "utf8")).toContain(
      `remote.example.test ssh-ed25519 ${key.toString("base64")}`,
    );
    expect(expectHostVerifier(buildSshConfig(target, {
      env: {},
      homeDir,
      sshConfigPath: null,
    }))(key)).toBe(true);
  });

  it("refuses to overwrite a different known SSH host key", async () => {
    const knownKey = Buffer.from("known host key");
    const scannedKey = Buffer.from("new host key");
    const { homeDir } = createSshHomeWithKnownHosts(
      `remote.example.test ssh-ed25519 ${knownKey.toString("base64")}\n`,
    );

    await expect(trustSshHostKeyForTarget(target, "SHA256:test-key", {
      env: {},
      homeDir,
      sshConfigPath: null,
      scanHostKey: async () => scannedHostKey({ homeDir, key: scannedKey }),
    })).rejects.toThrow("different SSH host key saved");
  });

  it("reports a trusted SSH host key when the scanned key matches known_hosts", async () => {
    const key = Buffer.from("remote host key");
    const { homeDir } = createSshHomeWithKnownHosts(
      `remote.example.test ssh-ed25519 ${key.toString("base64")}\n`,
    );

    await expect(getSshHostKeyTrustForTarget(target, {
      env: {},
      homeDir,
      sshConfigPath: null,
      scanHostKey: async () => scannedHostKey({ homeDir, key }),
    })).resolves.toMatchObject({
      state: "trusted",
      targetId: target.id,
      host: target.hostname,
    });
  });

  it("reports a changed SSH host key when known_hosts has a different key", async () => {
    const knownKey = Buffer.from("known host key");
    const scannedKey = Buffer.from("new host key");
    const { homeDir } = createSshHomeWithKnownHosts(
      `remote.example.test ssh-ed25519 ${knownKey.toString("base64")}\n`,
    );

    await expect(getSshHostKeyTrustForTarget(target, {
      env: {},
      homeDir,
      sshConfigPath: null,
      scanHostKey: async () => scannedHostKey({ homeDir, key: scannedKey }),
    })).resolves.toMatchObject({
      state: "changed",
      targetId: target.id,
      host: target.hostname,
    });
  });

  it("explains SSH servers that close before the handshake during host-key scan", async () => {
    const server = net.createServer((socket) => {
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Expected TCP test server to bind an address.");
    }

    try {
      await expect(scanSshHostKeyForTarget({
        ...target,
        hostname: "127.0.0.1",
        port: address.port,
      }, {
        env: {},
        sshConfigPath: null,
      })).rejects.toThrow(
        `SSH server at 127.0.0.1:${address.port} closed the connection before ADE could finish the SSH handshake.`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out SSH sockets that never finish the handshake", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Expected TCP test server to bind an address.");
    }

    try {
      await expect(scanSshHostKeyForTarget({
        ...target,
        hostname: "127.0.0.1",
        port: address.port,
      }, {
        env: { ADE_REMOTE_SSH_CONNECT_TIMEOUT_MS: "75" } as NodeJS.ProcessEnv,
        knownHostsPath: null,
        sshConfigPath: null,
      })).rejects.toThrow(
        `Timed out while waiting for the SSH handshake from 127.0.0.1:${address.port}.`,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects unknown SSH host keys by default", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-home-"));
    const config = buildSshConfig(target, {
      env: {},
      homeDir,
      sshConfigPath: null,
    });

    expect(expectHostVerifier(config)(Buffer.from("remote host key"))).toBe(false);
    expect(hasKnownSshHostKeyForTarget(target, {
      homeDir,
      sshConfigPath: null,
    })).toBe(false);
  });
});

describe("parseOpenSshHostConfig", () => {
  it("keeps the first matching value and supports wildcard blocks", () => {
    expect(parseOpenSshHostConfig([
      "Host *.example.test",
      "  User remote-user",
      "  Port 2200",
      "Host remote.example.test",
      "  User ignored",
      "  HostName 10.0.0.5",
    ].join("\n"), "remote.example.test")).toEqual({
      user: "remote-user",
      port: 2200,
      hostName: "10.0.0.5",
    });
  });
});
