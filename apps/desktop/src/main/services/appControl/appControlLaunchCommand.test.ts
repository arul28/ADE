import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandForwardsAppControlDebug,
  commandLooksLikeDirectElectronLaunch,
  commandLooksLikePackageScriptLaunch,
  insertDebugFlagsIntoDirectElectronCommand,
  rewritePackageScriptElectronLaunch,
} from "./appControlLaunchCommand";

const DEBUG_FLAGS = ["--remote-debugging-port=9222"];

describe("appControlLaunchCommand", () => {
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
      expect(rewritePackageScriptElectronLaunch("npm run dev", DEBUG_FLAGS, projectRoot))
        .toBe(`PATH=${path.join(projectRoot, "node_modules", ".bin")}:$PATH electron --remote-debugging-port=9222 .`);
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

      expect(rewritePackageScriptElectronLaunch("cd apps/desktop && npm run dev", DEBUG_FLAGS, projectRoot))
        .toBe(`cd apps/desktop && PATH=${path.join(appDir, "node_modules", ".bin")}:$PATH electron --remote-debugging-port=9222 .`);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
