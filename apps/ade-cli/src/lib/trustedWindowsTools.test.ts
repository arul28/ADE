import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveTrustedWindowsTool,
  TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT,
  trustedWindowsToolKernelPath,
  type TrustedWindowsTool,
} from "./trustedWindowsTools";

describe("trusted Windows tool resolution", () => {
  it("derives and validates the executable from the kernel SystemRoot alias", () => {
    const kernelTool = trustedWindowsToolKernelPath("powershell");
    const canonicalRoot = String.raw`C:\Windows\System32`;
    const canonicalTool = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

    expect(resolveTrustedWindowsTool("powershell", {
      platform: "win32",
      realpathNative: (filePath) => {
        if (filePath === TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT) return canonicalRoot;
        if (filePath === kernelTool) return canonicalTool;
        throw new Error(`unexpected path: ${filePath}`);
      },
      statSync: () => ({ isFile: () => true }),
    })).toBe(canonicalTool);
  });

  it("rejects a canonical tool redirected outside System32", () => {
    expect(() => resolveTrustedWindowsTool("reg", {
      platform: "win32",
      realpathNative: (filePath) => filePath === TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT
        ? String.raw`C:\Windows\System32`
        : String.raw`C:\poison\reg.exe`,
      statSync: () => ({ isFile: () => true }),
    })).toThrow(/Refusing untrusted Windows reg executable/);
  });

  it("rejects a kernel root that does not canonicalize to System32", () => {
    expect(() => resolveTrustedWindowsTool("taskkill", {
      platform: "win32",
      realpathNative: (filePath) => filePath === TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT
        ? String.raw`C:\poison`
        : String.raw`C:\poison\taskkill.exe`,
      statSync: () => ({ isFile: () => true }),
    })).toThrow(/Refusing untrusted Windows taskkill executable/);
  });

  it("rejects a trusted path that is not a file", () => {
    expect(() => resolveTrustedWindowsTool("schtasks", {
      platform: "win32",
      realpathNative: (filePath) => filePath === TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT
        ? String.raw`C:\Windows\System32`
        : String.raw`C:\Windows\System32\schtasks.exe`,
      statSync: () => ({ isFile: () => false }),
    })).toThrow(/is not a file/);
  });

  const nativeWindowsTest = process.platform === "win32" ? it : it.skip;
  nativeWindowsTest("ignores cwd, PATH, SystemRoot, and windir poisoning on Windows", () => {
    const poisonDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-trusted-tools-poison-"));

    try {
      for (const tool of ["powershell.exe", "reg.exe", "schtasks.exe", "taskkill.exe"]) {
        fs.writeFileSync(path.join(poisonDir, tool), "not a Windows executable");
      }
      const moduleUrl = pathToFileURL(path.resolve("src/lib/trustedWindowsTools.ts")).href;
      const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
      const childScript = `
        import { spawnSync } from "node:child_process";
        import fs from "node:fs";
        import path from "node:path";
        import { resolveTrustedWindowsTool, TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT } from ${JSON.stringify(moduleUrl)};
        const originalSystemRoot = process.env.SystemRoot;
        const originalWindir = process.env.windir;
        process.env.SystemRoot = ${JSON.stringify(poisonDir)};
        process.env.windir = ${JSON.stringify(poisonDir)};
        const tools = ["powershell", "reg", "schtasks", "taskkill"];
        const canonicalRoot = fs.realpathSync.native(TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT);
        const resolved = Object.fromEntries(tools.map((tool) => [tool, resolveTrustedWindowsTool(tool)]));
        process.env.SystemRoot = originalSystemRoot;
        process.env.windir = originalWindir;
        const powershell = spawnSync(
          resolved.powershell,
          ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write('trusted')"],
          { encoding: "utf8", windowsHide: true },
        );
        process.stdout.write(JSON.stringify({
          canonicalRoot,
          resolved,
          powershell: { status: powershell.status, stdout: powershell.stdout, error: powershell.error?.message },
        }));
      `;
      const child = spawnSync(process.execPath, [tsxCli, "--eval", childScript], {
        cwd: poisonDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: poisonDir,
        },
        windowsHide: true,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout) as {
        canonicalRoot: string;
        resolved: Record<TrustedWindowsTool, string>;
        powershell: { status: number | null; stdout: string; error?: string };
      };
      for (const resolved of Object.values(result.resolved)) {
        expect(path.win32.relative(result.canonicalRoot, resolved)).not.toMatch(/^\.\.(?:\\|$)/);
        expect(resolved.toLowerCase()).not.toContain(poisonDir.toLowerCase());
      }
      expect(result.powershell).toEqual({ status: 0, stdout: "trusted" });
    } finally {
      fs.rmSync(poisonDir, { force: true, recursive: true });
    }
  });
});
