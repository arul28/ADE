import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grokTaskConfigToml, openProviderTaskMcpOff } from "./providerTaskMcpOff";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-task-test-"));
  vi.stubEnv("ADE_HOME", path.join(root, "ade"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("background provider homes", () => {
  it("preserves credential updates and concurrent writes when closing the copy", () => {
    const home = path.join(root, "grok");
    fs.mkdirSync(path.join(home, "history"), { recursive: true });
    for (const name of ["token", "concurrent", "inplace"]) fs.writeFileSync(path.join(home, name), "original");
    fs.chmodSync(path.join(home, "token"), 0o600);
    const job = openProviderTaskMcpOff("grok", { GROK_HOME: home });
    const copy = job.env.GROK_HOME;
    expect(copy).toBeTruthy();
    for (const name of ["token", "concurrent"]) {
      fs.writeFileSync(path.join(copy, `${name}.new`), "refreshed");
      fs.renameSync(path.join(copy, `${name}.new`), path.join(copy, name));
    }
    fs.writeFileSync(path.join(home, "concurrent"), "another writer wins");
    fs.writeFileSync(path.join(copy, "inplace"), "in place");
    fs.writeFileSync(path.join(copy, "history", "entry"), "history");
    job.close();
    job.close();
    expect(fs.readFileSync(path.join(home, "token"), "utf8")).toBe("refreshed");
    if (process.platform !== "win32") expect(fs.statSync(path.join(home, "token")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(home, "concurrent"), "utf8")).toBe("another writer wins");
    expect(fs.readFileSync(path.join(home, "inplace"), "utf8")).toBe("in place");
    expect(fs.readFileSync(path.join(home, "history", "entry"), "utf8")).toBe("history");
    expect(fs.existsSync(copy)).toBe(false);
  });

  it("removes Devin server settings and disables imports while preserving other settings", () => {
    const configHome = path.join(root, "config");
    const home = path.join(configHome, "devin");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ theme: "dark", mcpServers: { server: {} }, read_config_from: { cursor: true, custom: true } }));
    fs.writeFileSync(path.join(home, "config.local.json"), JSON.stringify({ model: "x", mcpServers: { server: {} } }));
    for (const name of ["mcp_config.json", "mcp_config.local.json"]) fs.writeFileSync(path.join(home, name), "{}");
    const job = openProviderTaskMcpOff("devin", { XDG_CONFIG_HOME: configHome, APPDATA: configHome });
    const copy = path.join(job.env[process.platform === "win32" ? "APPDATA" : "XDG_CONFIG_HOME"], "devin");
    expect(JSON.parse(fs.readFileSync(path.join(copy, "config.json"), "utf8"))).toEqual({ theme: "dark", read_config_from: { custom: true, cursor: false, windsurf: false, claude: false, opencode: false, vscode: false, zed: false } });
    expect(JSON.parse(fs.readFileSync(path.join(copy, "config.local.json"), "utf8"))).toEqual({ model: "x" });
    for (const name of ["mcp_config.json", "mcp_config.local.json"]) expect(fs.existsSync(path.join(copy, name))).toBe(false);
    job.close();
    expect(fs.existsSync(path.join(home, "mcp_config.json"))).toBe(true);
  });


});

describe("Grok background configuration", () => {
  it("removes servers and disables imported servers without losing other settings", () => {
    const result = grokTaskConfigToml('mcp_servers = {}\nmodel = "x"\n[mcp_servers.example]\ncommand = "server"\n[compat.claude]\nmcps = true\nother = true\n');
    expect(result).toContain('model = "x"');
    expect(result).not.toContain("mcp_servers");
    expect(result).not.toContain("mcps = true");
    expect(result).toContain('[compat.claude]\nmcps = false\nother = true');
    expect(result).toContain('[compat.cursor]\nmcps = false');
    expect(result).toContain('[compat.codex]\nmcps = false');
  });
  it.each(['[compat."claude"]', '[compat.claude.x]', '[compat]'])("preserves alternative compat table %s", (header) => {
    const input = `${header}\nmcps = true\n`;
    expect(grokTaskConfigToml(input)).toBe(input);
  });
});
