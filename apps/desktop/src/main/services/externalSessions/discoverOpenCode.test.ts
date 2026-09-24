import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverOpenCodeSessions, isAdeBackgroundTaskTitle } from "./discoverOpenCode";
import { clearOpenCodeBinaryCache } from "../opencode/openCodeBinaryManager";

describe("isAdeBackgroundTaskTitle", () => {
  it("matches ADE's own background prompts by exact task name", () => {
    expect(isAdeBackgroundTaskTitle("ADE terminal_summaries")).toBe(true);
    expect(isAdeBackgroundTaskTitle("ADE session summary")).toBe(true);
    expect(isAdeBackgroundTaskTitle("ADE initial chat title")).toBe(true);
  });

  it("keeps user sessions that only start with ADE", () => {
    expect(isAdeBackgroundTaskTitle("ADE router with thinking tiers")).toBe(false);
    expect(isAdeBackgroundTaskTitle("AI Chat")).toBe(false);
    expect(isAdeBackgroundTaskTitle(null)).toBe(false);
  });
});

describe("OpenCode exact lookup", () => {
  let dir: string;
  let previousPath: string | undefined;
  let previousDisable: string | undefined;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-opencode-lookup-")));
    previousPath = process.env.PATH;
    previousDisable = process.env.ADE_DISABLE_BUNDLED_OPENCODE;
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousDisable === undefined) delete process.env.ADE_DISABLE_BUNDLED_OPENCODE;
    else process.env.ADE_DISABLE_BUNDLED_OPENCODE = previousDisable;
    clearOpenCodeBinaryCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds a session from another folder through export when the scoped list misses it", async () => {
    // 2026-09-23: `session list` only shows the folder it runs in, so the
    // preview's lookup found nothing and showed "No messages to show".
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    const id = "ses_lookup0000000000000001";
    const exported = {
      info: { id, directory: project, title: "Continuing interrupted work", time: { created: 1_790_202_088_894, updated: 1_790_202_211_739 } },
      messages: [{ info: { role: "user" }, parts: [] }, { info: { role: "assistant" }, parts: [] }],
    };
    fs.writeFileSync(
      path.join(dir, "payload.cjs"),
      `const args = process.argv.slice(2);\n`
        + `if (args[0] === "session") process.stdout.write("[]");\n`
        + `else process.stdout.write(${JSON.stringify(JSON.stringify(exported))});\n`,
      "utf8",
    );
    const script = path.join(dir, process.platform === "win32" ? "opencode.cmd" : "opencode");
    fs.writeFileSync(
      script,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "%~dp0payload.cjs" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/payload.cjs" "$@"\n`,
      "utf8",
    );
    fs.chmodSync(script, 0o755);
    process.env.PATH = dir;
    process.env.ADE_DISABLE_BUNDLED_OPENCODE = "1";
    clearOpenCodeBinaryCache();

    const [record] = await discoverOpenCodeSessions({ sessionId: id, homeDir: dir });

    expect(record).toMatchObject({
      provider: "opencode",
      id,
      cwd: project,
      title: "Continuing interrupted work",
      messageCount: 1,
      updatedAt: 1_790_202_211_739,
    });
  });
});
