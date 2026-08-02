import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandForwardsAppControlDebug,
  commandLooksLikeDirectElectronLaunch,
  commandLooksLikePackageScriptLaunch,
  insertDebugFlagsIntoDirectElectronCommand,
  resolveDirectElectronLaunch,
  resolvePackageScriptElectronLaunch,
  rewritePackageScriptElectronLaunch,
  shellQuote,
} from "./appControlLaunchCommand";

const DEBUG_FLAGS = ["--remote-debugging-port=9222"];

describe("appControlLaunchCommand", () => {
  it("resolves direct Windows Electron commands into argv and env without shell interpolation", () => {
    const value = "C:\\Program Files\\ADE's $lane %TEMP% & café";
    expect(resolveDirectElectronLaunch(
      `ADE_TEST="${value}" npx electron "C:\\Program Files\\My & App café"`,
      DEBUG_FLAGS,
      { platform: "win32" },
    )).toEqual({
      command: "npx",
      args: ["electron", ...DEBUG_FLAGS, "C:\\Program Files\\My & App café"],
      env: { ADE_TEST: value },
      commandForDisplay: expect.any(String),
    });
  });

  it("falls back to the configured shell for single-quoted Windows argv", () => {
    expect(resolveDirectElectronLaunch(
      "electron 'C:\\Program Files\\My App\\main.js'",
      DEBUG_FLAGS,
      { platform: "win32" },
    )).toBeNull();
  });

  it("resolves package scripts into a direct local Electron invocation on Windows", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade app control $ % & café-"));
    try {
      fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
        scripts: {
          dev: "ADE_TEST=\"quoted $value %TEMP% & café\" electron \"app folder\"",
        },
      }), "utf8");

      const resolved = resolvePackageScriptElectronLaunch(
        "npm run dev",
        DEBUG_FLAGS,
        projectRoot,
        { platform: "win32" },
      );
      expect(resolved).toEqual({
        command: path.join(projectRoot, "node_modules", ".bin", "electron.cmd"),
        args: [...DEBUG_FLAGS, "app folder"],
        cwd: projectRoot,
        env: { ADE_TEST: "quoted $value %TEMP% & café" },
        commandForDisplay: expect.any(String),
      });
      expect(resolved?.commandForDisplay).not.toContain("PATH=");
      expect(resolved?.commandForDisplay).not.toContain("$PATH");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("emits native PowerShell and cmd environment syntax for complex Windows script fallbacks", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade app control $ % & café-"));
    try {
      fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
        scripts: {
          dev: "electron . && node post-launch.js",
        },
      }), "utf8");

      const powershell = rewritePackageScriptElectronLaunch(
        "npm run dev",
        DEBUG_FLAGS,
        projectRoot,
        { platform: "win32", shell: "powershell" },
      );
      expect(powershell).toContain("Set-Location -LiteralPath '");
      expect(powershell).toContain("$env:PATH = '");
      expect(powershell).toContain("' + $env:PATH;");
      expect(powershell).not.toContain(":$PATH");
      expect(powershell).not.toContain(" && ");

      const cmd = rewritePackageScriptElectronLaunch(
        "npm run dev",
        DEBUG_FLAGS,
        projectRoot,
        { platform: "win32", shell: "cmd" },
      );
      expect(cmd).toContain('cd /d "');
      expect(cmd).toContain('set "PATH=');
      expect(cmd).toContain(';%PATH%" &&');
      expect(cmd).not.toContain(":$PATH");

      const gitBash = rewritePackageScriptElectronLaunch(
        "npm run dev",
        DEBUG_FLAGS,
        projectRoot,
        { platform: "win32", shell: "git-bash" },
      );
      expect(gitBash).toMatch(/^cd -- '?\/[a-z]\//);
      expect(gitBash).toContain("/node_modules/.bin'");
      expect(gitBash).toContain(":$PATH");
      expect(gitBash).toContain(" && ");
      expect(gitBash).not.toContain("Set-Location");
      expect(gitBash).not.toContain('set "PATH=');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("detects direct Electron launches and injects debug flags after electron", () => {
    expect(commandLooksLikeDirectElectronLaunch("FOO=bar npx electron .")).toBe(true);

    expect(insertDebugFlagsIntoDirectElectronCommand("FOO=bar npx electron .", DEBUG_FLAGS))
      .toBe("FOO=bar npx electron --remote-debugging-port=9222 .");
  });

  it("detects package script launches and rewrites direct Electron scripts", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-app-control-launch-"));
    try {
      fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
        scripts: {
          dev: "electron .",
        },
      }), "utf8");

      expect(commandLooksLikePackageScriptLaunch("npm run dev")).toBe(true);
      expect(rewritePackageScriptElectronLaunch(
        "npm run dev",
        DEBUG_FLAGS,
        projectRoot,
        { platform: "linux" },
      ))
        .toBe(`PATH=${shellQuote(path.join(projectRoot, "node_modules", ".bin"))}:$PATH electron --remote-debugging-port=9222 .`);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not rewrite scripts that already forward App Control flags", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-app-control-launch-"));
    try {
      fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
        scripts: {
          dev: "electron . {ADE_APP_CONTROL_DEBUG_FLAGS}",
        },
      }), "utf8");

      expect(commandForwardsAppControlDebug("electron . {ADE_APP_CONTROL_DEBUG_FLAGS}")).toBe(true);
      expect(rewritePackageScriptElectronLaunch("npm run dev", DEBUG_FLAGS, projectRoot)).toBeNull();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("resolves the last cd segment before reading package.json", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-app-control-launch-"));
    const appDir = path.join(projectRoot, "apps", "desktop");
    try {
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({
        scripts: {
          dev: "electron .",
        },
      }), "utf8");

      expect(rewritePackageScriptElectronLaunch(
        "cd apps/desktop && npm run dev",
        DEBUG_FLAGS,
        projectRoot,
        { platform: "linux" },
      ))
        .toBe(`cd apps/desktop && PATH=${shellQuote(path.join(appDir, "node_modules", ".bin"))}:$PATH electron --remote-debugging-port=9222 .`);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
