import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const cleanupScript = path.resolve("scripts", "windows-uninstall-cleanup.ps1");

function stripExtendedPathPrefix(value) {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function realWindowsPath(value) {
  return stripExtendedPathPrefix(fs.realpathSync.native(value));
}

function windowsPathIdentity(value) {
  return path.win32.normalize(realWindowsPath(value)).replace(/[\\/]+$/, "").toLowerCase();
}

function shortWindowsPath(value) {
  const script = [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public static class AdeTestPathInterop {",
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    "  public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint bufferLength);",
    "}",
    "'@ | Out-Null",
    "$buffer = New-Object System.Text.StringBuilder 32768",
    "$length = [AdeTestPathInterop]::GetShortPathName($env:ADE_TEST_PATH, $buffer, [uint32]$buffer.Capacity)",
    "if ($length -eq 0) { exit 1 }",
    "[Console]::Out.Write($buffer.ToString())",
  ].join("\r\n");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedScript,
  ], {
    encoding: "utf8",
    env: { ...process.env, ADE_TEST_PATH: value },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const resolved = result.stdout.trim();
  assert.notEqual(resolved, "", "PowerShell did not return a path representation");
  return resolved;
}

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
  const longInstallDir = realWindowsPath(installDir);
  const shortPackagedCliDir = shortWindowsPath(packagedCliDir);
  fs.writeFileSync(
    path.join(cliBinDir, "ade.cmd"),
    `@echo off\r\n"${path.join(shortPackagedCliDir, "ade.cmd")}" %*\r\n`,
  );
  fs.writeFileSync(
    path.join(cliBinDir, "ade-alpha.cmd"),
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
    longInstallDir,
    "-CliBinDir",
    cliBinDir,
    "-SkipServiceRemoval",
    "-SkipUserPathUpdate",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(cliBinDir, "ade.cmd")), false);
  assert.equal(fs.existsSync(path.join(cliBinDir, "ade-alpha.cmd")), false);
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

  const unpackedNodeModules = path.join(installDir, "resources", "app.asar.unpacked", "node_modules");
  const packedNodeModules = path.join(installDir, "resources", "app.asar", "node_modules");
  fs.mkdirSync(unpackedNodeModules, { recursive: true });
  fs.mkdirSync(packedNodeModules, { recursive: true });

  const appExecutableName = "ADE Beta.exe";
  fs.copyFileSync(process.execPath, path.join(installDir, appExecutableName));
  fs.writeFileSync(path.join(cliRoot, "cli.cjs"), [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({`,
    "  argv: process.argv.slice(2),",
    "  packageChannel: process.env.ADE_PACKAGE_CHANNEL,",
    "  adeHome: process.env.ADE_HOME,",
    "  nodePath: process.env.NODE_PATH,",
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
    shortWindowsPath(installDir),
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
      NODE_PATH: "C:\\existing-node-modules",
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const observed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.deepEqual(observed.argv, ["serve", "--uninstall-service"]);
  assert.equal(observed.packageChannel, "beta");
  assert.equal(path.win32.basename(observed.adeHome), ".ade-beta");
  const observedNodePath = observed.nodePath.split(path.delimiter);
  assert.deepEqual(observedNodePath.slice(0, 2).map(windowsPathIdentity), [
    windowsPathIdentity(unpackedNodeModules),
    windowsPathIdentity(packedNodeModules),
  ]);
  assert.equal(observedNodePath[2], "C:\\existing-node-modules");
});

test("Windows uninstall cleanup reports the packaged executable exit code", {
  skip: process.platform !== "win32",
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade failed uninstall "));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const installDir = path.join(tempRoot, "ADE");
  const cliRoot = path.join(installDir, "resources", "ade-cli");
  const cliBinDir = path.join(tempRoot, "empty user bin");
  fs.mkdirSync(cliRoot, { recursive: true });
  fs.mkdirSync(cliBinDir, { recursive: true });

  const appExecutableName = "ADE.exe";
  fs.copyFileSync(process.execPath, path.join(installDir, appExecutableName));
  fs.writeFileSync(path.join(cliRoot, "cli.cjs"), "process.exitCode = 19;\n");

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
    "-CliBinDir",
    cliBinDir,
    "-SkipUserPathUpdate",
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /cleanup command exited with code 19/i);
});
