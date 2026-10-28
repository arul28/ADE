import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackedCliUserMcpFlags } from "../../../shared/cliLaunch";
import { resolveCodexUserServers } from "./mcpUserServersForLaunch";
import { createNpxDirectLauncher, npxCacheInstallDir } from "./npxDirectLaunch";
import { resolveTrackedCliUserMcp } from "./trackedCliUserMcp";
import { scanProviderMcpConfigs } from "./mcpProviderConfigScan";
import { createMcpRegistryAuthTokenResolver } from "./mcpRegistryService";

let root: string;

function write(file: string, contents: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mcp-launch-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the user's MCP servers at launch", () => {
  it.each(["account", "machine"])("does not hand a token to a server switched off for the %s", async (scope) => {
    const url = "https://example.test/mcp";
    const server = { name: "example", transport: "http", url, enabled: scope !== "account" };
    const settings: Record<string, unknown> = { "all\u0000mcp.servers": { value: [server] } };
    if (scope === "machine") settings["all\u0000device.test-device.mcp.off"] = { value: ["example"] };
    write(path.join(root, "secrets", "sync-device-id"), "test-device");
    write(path.join(root, "account-settings.json"), JSON.stringify({ settings }));
    const token = JSON.stringify({ v: 1, url, accessToken: "secret", clientId: "client", tokenEndpoint: "https://example.test/token" });
    const resolve = createMcpRegistryAuthTokenResolver({ adeHome: root, readSecret: () => token, writeSecret: () => true });

    const result = await resolve(url);
    expect(result.registryConfigured).toBe(true);
    expect(result.off).toBe(true);
    expect(result.accessToken).toBeUndefined();
  });
  it("imports user provider configs while excluding repository configs", () => {
    const home = path.join(root, "home");
    const copilot = path.join(root, "copilot-override");
    const project = path.join(root, "project");
    write(path.join(copilot, "mcp-config.json"), JSON.stringify({ mcpServers: { notion: { url: "https://notion.example/mcp" } } }));
    write(path.join(home, ".qwen", "settings.json"), JSON.stringify({ mcpServers: { qwen: { url: "https://qwen.example/events" } } }));
    write(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { untrusted: { command: "untrusted" } } }));

    const { servers } = scanProviderMcpConfigs({ homeDir: home, projectRoot: project, env: { COPILOT_HOME: copilot } });
    expect(servers.map((server) => server.name)).toEqual(["notion", "qwen"]);
    expect(servers[0]).toMatchObject({ providers: ["copilot"], transport: "http" });
    expect(servers[1]).toMatchObject({ providers: ["qwen"], transport: "sse" });
  });
  it("gives a Codex chat on an ADE account the login's servers, without doubling or editing anything", async () => {
    const loginHome = path.join(root, "codex-login");
    const accountHome = path.join(root, "codex-account");
    const project = path.join(root, "project");
    const loginConfig = write(path.join(loginHome, "config.toml"), [
      "[mcp_servers.docs]",
      'url = "https://docs.example/mcp"',
      "",
      "[mcp_servers.repo]",
      'command = "/usr/local/bin/repo-mcp"',
      'args = ["serve"]',
      "",
      "[mcp_servers.both]",
      'command = "/usr/local/bin/login-copy"',
      "",
      "[mcp_servers.project_owned]",
      'command = "/usr/local/bin/login-copy"',
      "",
      "[mcp_servers.off]",
      'command = "/usr/local/bin/off"',
      "enabled = false",
      "",
    ].join("\n"));
    const accountConfig = write(path.join(accountHome, "config.toml"), '[mcp_servers.both]\ncommand = "/usr/local/bin/account-copy"\n');
    // A project's config comes with the repository; a table named like a
    // prototype must not reach ADE's own objects.
    write(path.join(project, ".codex", "config.toml"), '[mcp_servers.project_owned]\ncommand = "/usr/local/bin/project-copy"\n\n[mcp_servers.__proto__]\npolluted = true\n');
    const before = [fs.readFileSync(loginConfig, "utf8"), fs.readFileSync(accountConfig, "utf8")];

    const overlay = await resolveCodexUserServers(createNpxDirectLauncher({ fetchImpl: vi.fn() }), {
      env: { ...process.env, CODEX_HOME: accountHome },
      baseEnv: { ...process.env, CODEX_HOME: loginHome },
      cwd: project,
    });

    // The account's own `both` and the project's `project_owned` keep their
    // own definitions (passing the login's would replace them); a server
    // switched off stays off.
    expect(Object.keys(overlay).sort()).toEqual(["docs", "repo"]);
    expect(overlay.repo).toMatchObject({ command: "/usr/local/bin/repo-mcp", args: ["serve"] });
    expect(overlay.docs).toMatchObject({ url: "https://docs.example/mcp" });
    expect([fs.readFileSync(loginConfig, "utf8"), fs.readFileSync(accountConfig, "utf8")]).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    { label: "the registry confirms the installed version", registry: { version: "1.2.0" }, direct: true, privateRegistry: false },
    { label: "a newer version is out", registry: { version: "1.3.0" }, direct: false, privateRegistry: false },
    { label: "the registry cannot be reached", registry: null, direct: false, privateRegistry: false },
    // npm's global config under `PREFIX` names a private registry: the public
    // one must not be asked about the package at all.
    { label: "npm uses a private registry", registry: { version: "1.2.0" }, direct: false, privateRegistry: true },
  ])("starts an npx server with node only when $label", async ({ registry, direct, privateRegistry }) => {
    const bin = path.join(root, "prefix", "bin");
    const npx = write(path.join(bin, "npx"), "#!/bin/sh\n");
    write(path.join(bin, process.platform === "win32" ? "node.exe" : "node"), "");
    const cache = path.join(root, "npm-cache");
    const installDir = npxCacheInstallDir(cache, "demo-mcp@latest");
    write(path.join(installDir, "package.json"), JSON.stringify({ _npx: { packages: ["demo-mcp@latest"] } }));
    const packageDir = path.join(installDir, "node_modules", "demo-mcp");
    write(path.join(packageDir, "package.json"), JSON.stringify({ name: "demo-mcp", version: "1.2.0", bin: { "demo-mcp": "cli.js" } }));
    const script = write(path.join(packageDir, "cli.js"), "#!/usr/bin/env node\n");
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const fetchImpl = vi.fn(async () => {
      if (!registry) throw new TypeError("fetch failed");
      return { ok: true, status: 200, json: async () => registry } as unknown as Response;
    });
    const launcher = createNpxDirectLauncher({ fetchImpl: fetchImpl as unknown as typeof fetch, homeDir: path.join(root, "home") });
    const server = { command: npx, args: ["-y", "demo-mcp@latest", "--stdio"] };
    const customPrefix = path.join(root, "custom-prefix");
    if (privateRegistry) write(path.join(customPrefix, "etc", "npmrc"), "registry=https://npm.internal.example/\n");
    const env = { PATH: bin, npm_config_cache: cache, ...(privateRegistry ? { PREFIX: customPrefix } : {}) };

    await launcher.prepare([server], { cwd: project, env });
    const resolved = launcher.resolve({ ...server, cwd: project, env });

    expect(fetchImpl).toHaveBeenCalledTimes(privateRegistry ? 0 : 1);
    if (!direct) {
      expect(resolved).toBeNull();
      return;
    }
    expect(resolved?.command).toBe(path.join(bin, process.platform === "win32" ? "node.exe" : "node"));
    expect(resolved?.args).toEqual([script, "--stdio"]);
    // npm's launcher puts the install's own `.bin` first; so does the direct launch.
    expect(Object.values(resolved?.env ?? {})[0]?.split(path.delimiter)[0]).toBe(path.join(installDir, "node_modules", ".bin"));
  });

  it("never puts a secret on a tracked CLI's command line", async () => {
    vi.stubEnv("ADE_HOME", path.join(root, "ade-home"));
    const codexLogin = path.join(root, "codex-login");
    write(path.join(codexLogin, "config.toml"), [
      "[mcp_servers.plain]",
      'command = "/usr/local/bin/plain-mcp"',
      'args = ["serve", "--stdio"]',
      "",
      "[mcp_servers.env_secret]",
      'command = "/usr/local/bin/x"',
      "[mcp_servers.env_secret.env]",
      'API_TOKEN = "sk-live-env-secret"',
      "",
      "[mcp_servers.flag_value]",
      'command = "/usr/local/bin/y"',
      'args = ["-p", "hunter2"]',
      "",
      "[mcp_servers.compact_flag]",
      'command = "/usr/local/bin/w"',
      'args = ["-pcorrecthorse"]',
      "",
      "[mcp_servers.url_query]",
      'url = "https://mcp.example/mcp?key=query-secret"',
      "",
    ].join("\n"));
    const claudeLogin = path.join(root, "claude-login");
    write(path.join(claudeLogin, ".claude.json"), JSON.stringify({
      mcpServers: { tool: { type: "stdio", command: "/usr/local/bin/z", env: { API_TOKEN: "sk-live-claude-secret" } } },
    }));
    vi.stubEnv("CODEX_HOME", codexLogin);
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeLogin);
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });

    const codex = await resolveTrackedCliUserMcp({
      provider: "codex",
      cwd: project,
      instance: { id: "work", provider: "codex", configHome: path.join(root, "codex-account") },
    });
    const claude = await resolveTrackedCliUserMcp({
      provider: "claude",
      cwd: project,
      instance: { id: "work", provider: "claude", configHome: path.join(root, "claude-account") },
    });

    const codexLine = trackedCliUserMcpFlags("codex", codex).join(" ");
    expect(Object.keys(codex?.codex ?? {})).toEqual(["plain"]);
    for (const secret of ["sk-live-env-secret", "hunter2", "correcthorse", "query-secret"]) expect(codexLine).not.toContain(secret);
    // Claude gets every server, secrets included, from a private file: only its path is on the line.
    const claudeFlags = trackedCliUserMcpFlags("claude", claude);
    expect(claudeFlags).toEqual(["--mcp-config", claude?.claudeConfigPath]);
    expect(claudeFlags.join(" ")).not.toContain("sk-live-claude-secret");
    expect(JSON.parse(fs.readFileSync(claude!.claudeConfigPath!, "utf8")).mcpServers.tool.env.API_TOKEN).toBe("sk-live-claude-secret");
    if (process.platform !== "win32") expect(fs.statSync(claude!.claudeConfigPath!).mode & 0o077).toBe(0);
  });
});
