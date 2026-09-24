import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOpenCodeToFile } from "./openCodeCliOutput";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-opencode-out-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeCli(body: string): string {
  const payload = path.join(dir, "payload.cjs");
  fs.writeFileSync(payload, body, "utf8");
  if (process.platform === "win32") {
    const cmd = path.join(dir, "opencode.cmd");
    fs.writeFileSync(cmd, `@echo off\r\nnode "%~dp0payload.cjs"\r\n`, "utf8");
    return cmd;
  }
  const script = path.join(dir, "opencode");
  fs.writeFileSync(script, `#!/bin/sh\nexec node "$(dirname "$0")/payload.cjs"\n`, "utf8");
  fs.chmodSync(script, 0o755);
  return script;
}

describe("runOpenCodeToFile", () => {
  it("returns the whole stdout of a CLI that exits right after a large write", async () => {
    // 2026-09-23: a real 81 KB `session list` reached Node's pipe as 64 KB of broken JSON.
    const executable = fakeCli(
      `const rows = Array.from({ length: 2000 }, (_, i) => ({ id: "ses_" + i, title: "x".repeat(40) }));\n`
      + `process.stdout.write(JSON.stringify(rows));\nprocess.exit(0);\n`,
    );
    const result = await runOpenCodeToFile({
      executable, argv: [], env: process.env, timeoutMs: 10_000, maxBytes: 16 * 1024 * 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stdout.length).toBeGreaterThan(65_536);
    expect(JSON.parse(result.stdout)).toHaveLength(2000);
  });

  it("reports a non-zero exit and an oversized output", async () => {
    const failing = fakeCli(`process.exit(3);\n`);
    await expect(runOpenCodeToFile({
      executable: failing, argv: [], env: process.env, timeoutMs: 10_000, maxBytes: 1024,
    })).resolves.toMatchObject({ ok: false, reason: "exit_code" });
    const big = fakeCli(`process.stdout.write("y".repeat(4096));\n`);
    await expect(runOpenCodeToFile({
      executable: big, argv: [], env: process.env, timeoutMs: 10_000, maxBytes: 1024,
    })).resolves.toMatchObject({ ok: false, reason: "too_large" });
  });
  it.skipIf(process.platform === "win32")("writes the export to an owner-only file", async () => {
    const cli = fakeCli(`process.stdout.write(String(require("node:fs").fstatSync(1).mode & 0o777));\n`);
    const result = await runOpenCodeToFile({
      executable: cli, argv: [], env: process.env, timeoutMs: 10_000, maxBytes: 1024,
    });
    expect(result).toEqual({ ok: true, stdout: String(0o600) });
  });

  it("reports a timeout after the CLI is stopped and leaves no output file", async () => {
    // A private temp folder: other suites write `ade-opencode-*` files to the shared one.
    const privateTmp = fs.mkdtempSync(path.join(dir, "tmp-"));
    const tmpVars = ["TMPDIR", "TEMP", "TMP"] as const;
    const previous = tmpVars.map((name) => process.env[name]);
    for (const name of tmpVars) process.env[name] = privateTmp;
    try {
      const slow = fakeCli(`setTimeout(() => {}, 60_000);\n`);
      const result = await runOpenCodeToFile({
        executable: slow, argv: [], env: process.env, timeoutMs: 300, maxBytes: 1024,
      });
      expect(result).toMatchObject({ ok: false, reason: "timeout" });
      expect(fs.readdirSync(privateTmp)).toEqual([]);
    } finally {
      tmpVars.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });
});
