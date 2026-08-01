import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createAuthenticodeProbe } from "./windows-authenticode.mjs";

test("Authenticode probe treats paths as data instead of PowerShell source", {
  skip: process.platform !== "win32",
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade signature probe "));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const targetPath = path.join(tempRoot, "unsigned & untrusted.ps1");
  fs.writeFileSync(targetPath, "Write-Output 'unsigned'\n");

  const probe = createAuthenticodeProbe(targetPath);
  const result = spawnSync(probe.command, probe.args, {
    env: probe.env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(Object.hasOwn(payload, "Status"));
  assert.doesNotMatch(result.stderr, /ParserError|positional parameter/i);
  if (!/module could not be loaded/i.test(result.stderr)) {
    assert.equal(payload.Status, "NotSigned");
  }
});
