import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import { buildSshConfig, buildSshConfigCandidates, buildSshRouteCandidates, buildSshUsernameCandidates, parseOpenSshHostConfig } from "./sshTransport";

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
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
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
