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

test("Windows uninstall cleanup uses the packaged executable and channel identity", {
  skip: process.platform !== "win32",
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade beta uninstall "));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const installDir = path.join(tempRoot, "ADE Beta");
  const cliRoot = path.join(installDir, "resources", "ade-cli");
  const cliBinDir = path.join(tempRoot, "empty user bin");
  const resultPath = path.join(tempRoot, "service-cleanup.json");
  fs.mkdirSync(cliRoot, { recursive: true });
  fs.mkdirSync(cliBinDir, { recursive: true });

  const appExecutableName = "ADE Beta.exe";
  fs.copyFileSync(process.execPath, path.join(installDir, appExecutableName));
  fs.writeFileSync(path.join(cliRoot, "cli.cjs"), [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({`,
    "  argv: process.argv.slice(2),",
    "  packageChannel: process.env.ADE_PACKAGE_CHANNEL,",
    "  adeHome: process.env.ADE_HOME,",
    "}));",
  ].join("\n"));

  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    cleanupScript,
    "-InstallDir",
    installDir,
    "-AppExecutableName",
    appExecutableName,
    "-PackageChannel",
    "beta",
    "-CliBinDir",
    cliBinDir,
    "-SkipUserPathUpdate",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      ADE_PACKAGE_CHANNEL: "alpha",
      ADE_HOME: "C:\\wrong-channel-home",
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const observed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.deepEqual(observed.argv, ["serve", "--uninstall-service"]);
  assert.equal(observed.packageChannel, "beta");
  assert.equal(path.win32.basename(observed.adeHome), ".ade-beta");
});
