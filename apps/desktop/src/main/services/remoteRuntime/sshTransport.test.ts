import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import { buildSshConfig, parseOpenSshHostConfig } from "./sshTransport";

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
