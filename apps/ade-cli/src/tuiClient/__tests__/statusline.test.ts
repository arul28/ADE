import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeStatusLineConfig, runClaudeStatusLineCommand } from "../statusline";

describe("statusline", () => {
  it("reads the nearest configured Claude statusLine command", () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ade-statusline-"));
    mkdirSync(path.join(workspaceRoot, ".claude"));
    writeFileSync(path.join(workspaceRoot, ".claude", "settings.json"), JSON.stringify({
      statusLine: { type: "command", command: "node project.js", refreshInterval: 2 },
    }));
    writeFileSync(path.join(workspaceRoot, ".claude", "settings.local.json"), JSON.stringify({
      statusLine: { type: "command", command: "node local.js", padding: 2, refreshInterval: 0 },
    }));

    const result = readClaudeStatusLineConfig(workspaceRoot);

    expect(result.config?.source).toBe("local");
    expect(result.config?.command).toBe("node local.js");
    expect(result.config?.padding).toBe(2);
    expect(result.config?.refreshIntervalSeconds).toBe(1);
    expect(result.diagnostics).toContain("project: command");
  });

  it("runs a statusLine command with JSON on stdin", async () => {
    const result = await runClaudeStatusLineCommand({
      type: "command",
      command: "node -e \"process.stdin.on('data', d => { const input = JSON.parse(d); process.stdout.write(input.model.displayName + ' · ' + input.context.percent); })\"",
      padding: 0,
      refreshIntervalSeconds: null,
      hideVimModeIndicator: false,
      source: "local",
      filePath: "/tmp/settings.json",
    }, {
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      projectRoot: process.cwd(),
      model: { displayName: "Claude" },
      context: { percent: 42 },
    });

    expect(result).toEqual({ ok: true, text: "Claude · 42" });
  });

  it("supports the documented Claude statusLine JSON fields", async () => {
    const result = await runClaudeStatusLineCommand({
      type: "command",
      command: "node -e \"process.stdin.on('data', d => { const input = JSON.parse(d); process.stdout.write(input.model.display_name + ' · ' + input.workspace.current_dir + ' · ' + input.context_window.used_percentage + ' · ' + input.session_id); })\"",
      padding: 0,
      refreshIntervalSeconds: null,
      hideVimModeIndicator: false,
      source: "local",
      filePath: "/tmp/settings.json",
    }, {
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      projectRoot: process.cwd(),
      model: { display_name: "Opus" },
      workspace: { current_dir: "/repo" },
      context_window: { used_percentage: 61 },
      session_id: "session-1",
    });

    expect(result).toEqual({ ok: true, text: "Opus · /repo · 61 · session-1" });
  });
});
