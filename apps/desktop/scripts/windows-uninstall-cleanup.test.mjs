import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const cleanupScript = path.resolve("scripts", "windows-uninstall-cleanup.ps1");

test("Windows uninstall cleanup removes only CLI shims owned by this installation", {
  skip: process.platform !== "win32",
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade uninstall cleanup "));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const installDir = path.join(tempRoot, "install & source");
  const packagedCliDir = path.join(installDir, "resources", "ade-cli", "bin");
  const cliBinDir = path.join(tempRoot, "user bin");
  fs.mkdirSync(packagedCliDir, { recursive: true });
  fs.mkdirSync(cliBinDir, { recursive: true });
  fs.writeFileSync(
    path.join(cliBinDir, "ade.cmd"),
    `@echo off\r\n"${path.join(packagedCliDir, "ade.cmd")}" %*\r\n`,
  );
  fs.writeFileSync(
    path.join(cliBinDir, "ade-beta.cmd"),
    '@echo off\r\n"C:\\Other ADE\\ade-beta.cmd" %*\r\n',
  );

  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    cleanupScript,
    "-InstallDir",
    installDir,
    "-CliBinDir",
    cliBinDir,
    "-SkipServiceRemoval",
    "-SkipUserPathUpdate",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(cliBinDir, "ade.cmd")), false);
  assert.equal(fs.existsSync(path.join(cliBinDir, "ade-beta.cmd")), true);
});
