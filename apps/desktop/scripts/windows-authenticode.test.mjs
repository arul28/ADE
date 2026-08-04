import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { AUTHENTICODE_PROBE_ERROR_STATUS, createAuthenticodeProbe } from "./windows-authenticode.mjs";

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
  // This assertion used to be skipped when stderr said "module could not be
  // loaded" -- which was this test observing the PSModulePath poisoning bug
  // and stepping around it instead of failing. The probe now strips
  // PSModulePath, so the answer must always be real.
  assert.equal(payload.Status, "NotSigned");
});

test("Authenticode probe survives inheriting PowerShell 7's PSModulePath", {
  skip: process.platform !== "win32",
}, (t) => {
  // Regression for the failure that killed the first two signed release runs:
  // GitHub runs workflow steps under pwsh, whose PSModulePath makes Windows
  // PowerShell 5.1 find a Core-only Microsoft.PowerShell.Security first and
  // fail to load it, so Get-AuthenticodeSignature dies before answering. The
  // fixture reconstructs that shadowing exactly; the probe must still answer.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-psmodulepath-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const moduleDir = path.join(tempRoot, "Microsoft.PowerShell.Security");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(
    path.join(moduleDir, "Microsoft.PowerShell.Security.psd1"),
    [
      "@{",
      "ModuleVersion = '7.0.0.0'",
      "PowerShellVersion = '7.2'",
      "CompatiblePSEditions = @('Core')",
      "CmdletsToExport = @('Get-AuthenticodeSignature')",
      "}",
      "",
    ].join("\n"),
  );
  const targetPath = path.join(tempRoot, "unsigned.ps1");
  fs.writeFileSync(targetPath, "Write-Output 'unsigned'\n");

  const probe = createAuthenticodeProbe(targetPath, {
    ...process.env,
    PSModulePath: tempRoot,
  });
  const result = spawnSync(probe.command, probe.args, {
    env: probe.env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.Status, "NotSigned");
  assert.doesNotMatch(String(payload.StatusMessage), /module could not be loaded/i);
});

test("Authenticode probe reports its own failure instead of an empty status", {
  skip: process.platform !== "win32",
}, () => {
  // Regression: when Get-AuthenticodeSignature threw (scanner lock, unreadable
  // file), $sig stayed null, every field stringified to empty, and the first
  // signed Windows release died with `...not Authenticode signed with a valid
  // signature: ` — a release blocker carrying zero diagnosis. The probe must
  // answer with a status no real signature check produces, plus the exception
  // text, so the validator can retry transients and name persistent failures.
  const probe = createAuthenticodeProbe(
    path.join(os.tmpdir(), "ade-authenticode-no-such-file.exe"),
  );
  const result = spawnSync(probe.command, probe.args, {
    env: probe.env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.Status, AUTHENTICODE_PROBE_ERROR_STATUS);
  assert.match(String(payload.StatusMessage), /not found|cannot find|does not exist/i);
});
