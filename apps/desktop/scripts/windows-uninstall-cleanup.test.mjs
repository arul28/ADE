import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const cleanupScript = path.resolve("scripts", "windows-uninstall-cleanup.ps1");
const cliWrapperScript = path.resolve("scripts", "ade-cli-windows-wrapper.cmd");
const installSetupScript = path.resolve("scripts", "windows-install-setup.ps1");
const standaloneInstallerScript = path.resolve("..", "ade-cli", "scripts", "install-runtime.ps1");

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

test("Windows standalone installer path normalizer is executable PowerShell", {
  skip: process.platform !== "win32",
}, () => {
  const probe = [
    "$tokens = $null",
    "$errors = $null",
    "$ast = [Management.Automation.Language.Parser]::ParseFile($env:ADE_TEST_SCRIPT, [ref]$tokens, [ref]$errors)",
    "if ($errors.Count -ne 0) { exit 2 }",
    "$functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-TrailingDirectorySeparators' }, $true))",
    "if ($functions.Count -ne 1) { exit 3 }",
  ].join("; ");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    probe,
  ], {
    encoding: "utf8",
    env: { ...process.env, ADE_TEST_SCRIPT: standaloneInstallerScript },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

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

test("Windows stable uninstall reaches protocol cleanup without treating it as C# source", {
  skip: process.platform !== "win32",
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade stable protocol cleanup "));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const installDir = path.join(tempRoot, "ADE");
  const cliBinDir = path.join(tempRoot, "empty user bin");
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(cliBinDir, { recursive: true });

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
    "ADE.exe",
    "-PackageChannel",
    "stable",
    "-CliBinDir",
    cliBinDir,
    "-SkipServiceRemoval",
    "-SkipUserPathUpdate",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("Windows uninstall still cleans a corrupted product whose executable is missing", {
  skip: process.platform !== "win32",
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade missing executable cleanup "));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const installDir = path.join(tempRoot, "ADE Beta");
  const cliBinDir = path.join(tempRoot, "empty user bin");
  const adeHome = path.join(tempRoot, ".ade-beta");
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(cliBinDir, { recursive: true });
  fs.mkdirSync(adeHome, { recursive: true });

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
    "ADE Beta.exe",
    "-PackageChannel",
    "beta",
    "-AdeHome",
    adeHome,
    "-CliBinDir",
    cliBinDir,
    "-SkipUserPathUpdate",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /packaged ADE executable or CLI is missing/i);
});

test("Windows bundled CLI wrapper resolves the Beta executable and identity", {
  skip: process.platform !== "win32",
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade beta wrapper "));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const resourcesDir = path.join(tempRoot, "resources");
  const cliRoot = path.join(resourcesDir, "ade-cli");
  const binDir = path.join(cliRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(cliWrapperScript, path.join(binDir, "ade-beta.cmd"));
  fs.copyFileSync(process.execPath, path.join(tempRoot, "ADE Beta.exe"));
  fs.writeFileSync(path.join(cliRoot, "channel"), "beta\r\n");
  const probe = path.join(tempRoot, "probe.cjs");
  fs.writeFileSync(probe, [
    "process.stdout.write(JSON.stringify({",
    "  channel: process.env.ADE_PACKAGE_CHANNEL,",
    "  appName: process.env.ADE_DESKTOP_APP_NAME,",
    "  argv: process.argv.slice(2),",
    "}));",
  ].join("\n"));

  const wrapperPath = path.join(binDir, "ade-beta.cmd");
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", [
    "/d",
    "/s",
    "/c",
    `""${wrapperPath}" probe-argument"`,
  ], {
    encoding: "utf8",
    // The wrapper only sets the channel identity `if not defined`, so an
    // ambient ADE_PACKAGE_CHANNEL wins over the bundled `channel` marker —
    // correct precedence, and exactly what this test must not inherit. A
    // terminal launched from an installed ADE carries those variables, so
    // running ADE's own suite from inside ADE would otherwise fail here with
    // the host channel's identity instead of the fixture's.
    env: {
      ...process.env,
      ADE_CLI_JS: probe,
      ADE_PACKAGE_CHANNEL: undefined,
      ADE_DESKTOP_APP_NAME: undefined,
      ADE_HOME: undefined,
    },
    windowsVerbatimArguments: true,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    channel: "beta",
    appName: "ADE Beta",
    argv: ["probe-argument"],
  });
});

test("Windows install setup compensates shim and startup state when service registration fails", {
  skip: process.platform !== "win32",
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade setup rollback "));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const installDir = path.join(tempRoot, "ADE Beta");
  const cliRoot = path.join(installDir, "resources", "ade-cli");
  const cliBin = path.join(cliRoot, "bin");
  const localAppData = path.join(tempRoot, "local app data");
  const cleanupMarker = path.join(tempRoot, "cleanup-ran.txt");
  fs.mkdirSync(cliBin, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(installDir, "ADE Beta.exe"));
  fs.copyFileSync(cleanupScript, path.join(cliRoot, "windows-uninstall-cleanup.ps1"));
  const cliWrapper = path.join(cliBin, "ade-beta.cmd");
  fs.writeFileSync(cliWrapper, [
    "@echo off",
    'if /I "%~2"=="--service-status" (',
    '  echo {"installed":false,"running":false}',
    "  exit /b 0",
    ")",
    'if /I "%~2"=="--uninstall-service" (',
    `  echo cleanup> "${cleanupMarker}"`,
    "  exit /b 0",
    ")",
    "exit /b 17",
  ].join("\r\n"));
  fs.writeFileSync(path.join(cliRoot, "cli.cjs"), "");
  fs.writeFileSync(path.join(cliRoot, "install-path.cmd"), [
    "@echo off",
    'if not exist "%~dp1" mkdir "%~dp1"',
    '> "%~1" echo @echo off',
    `>> "%~1" echo "${cliWrapper}" %%*`,
    "exit /b 0",
  ].join("\r\n"));

  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installSetupScript,
    "-InstallDir",
    installDir,
    "-AppExecutableName",
    "ADE Beta.exe",
    "-PackageChannel",
    "beta",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      USERPROFILE: path.join(tempRoot, "user profile"),
    },
  });

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /brain startup installer exited with code 17/i);
  assert.equal(fs.existsSync(path.join(localAppData, "ADE", "bin", "ade-beta.cmd")), false);
  assert.equal(fs.existsSync(cleanupMarker), true);
});

test("Windows failed repair restores the previous shim and startup service", {
  skip: process.platform !== "win32",
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade repair rollback "));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const installDir = path.join(tempRoot, "ADE Beta");
  const cliRoot = path.join(installDir, "resources", "ade-cli");
  const cliBin = path.join(cliRoot, "bin");
  const localAppData = path.join(tempRoot, "local app data");
  const targetShim = path.join(localAppData, "ADE", "bin", "ade-beta.cmd");
  const attemptMarker = path.join(tempRoot, "install-attempted.txt");
  const restoredMarker = path.join(tempRoot, "service-restored.txt");
  const previousShim = "@echo off\r\necho previous healthy shim\r\n";
  fs.mkdirSync(cliBin, { recursive: true });
  fs.mkdirSync(path.dirname(targetShim), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(installDir, "ADE Beta.exe"));
  fs.copyFileSync(cleanupScript, path.join(cliRoot, "windows-uninstall-cleanup.ps1"));
  fs.writeFileSync(targetShim, previousShim);
  const cliWrapper = path.join(cliBin, "ade-beta.cmd");
  fs.writeFileSync(cliWrapper, `@echo off\r\n"${process.execPath}" "%~dp0..\\cli.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  fs.writeFileSync(path.join(cliRoot, "cli.cjs"), [
    'const fs = require("node:fs");',
    'if (process.argv.includes("--service-status")) {',
    '  process.stdout.write(JSON.stringify({ installed: true, running: false }));',
    '} else if (process.argv.includes("--install-service")) {',
    `  if (!fs.existsSync(${JSON.stringify(attemptMarker)})) {`,
    `    fs.writeFileSync(${JSON.stringify(attemptMarker)}, "attempted");`,
    "    process.exitCode = 17;",
    "  } else {",
    `    fs.writeFileSync(${JSON.stringify(restoredMarker)}, "restored");`,
    "  }",
    "}",
  ].join("\n"));
  fs.writeFileSync(path.join(cliRoot, "install-path.cmd"), [
    "@echo off",
    'if not exist "%~dp1" mkdir "%~dp1"',
    '> "%~1" echo @echo off',
    `>> "%~1" echo "${cliWrapper}" %%*`,
    "exit /b 0",
  ].join("\r\n"));

  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", installSetupScript,
    "-InstallDir", installDir,
    "-AppExecutableName", "ADE Beta.exe",
    "-PackageChannel", "beta",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      USERPROFILE: path.join(tempRoot, "user profile"),
    },
  });

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /brain startup installer exited with code 17/i);
  assert.equal(fs.readFileSync(targetShim, "utf8"), previousShim);
  assert.equal(fs.existsSync(restoredMarker), true);
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
  const packagedCliBin = path.join(cliRoot, "bin");
  fs.mkdirSync(packagedCliBin, { recursive: true });
  fs.mkdirSync(cliBinDir, { recursive: true });
  fs.writeFileSync(
    path.join(cliBinDir, "ade-beta.cmd"),
    `@echo off\r\n"${path.join(packagedCliBin, "ade-beta.cmd")}" %*\r\n`,
  );

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
  assert.equal(fs.existsSync(path.join(cliBinDir, "ade-beta.cmd")), false);
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
