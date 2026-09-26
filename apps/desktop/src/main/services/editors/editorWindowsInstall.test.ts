import { describe, expect, it } from "vitest";

import {
  _testing as installTesting,
  parseRegistryUninstallOutput,
  resolveWindowsEditorExecutable,
  type WindowsEditorInstallIo,
} from "./editorWindowsInstall";
import { _testing as detectionTesting } from "./editorDetection";
import { EDITOR_TARGETS } from "../../../shared/editorTargets";

function fakeIo(options: {
  files?: string[];
  dirs?: Record<string, string[]>;
  registryApps?: WindowsEditorInstallIo["registryApps"];
  env?: NodeJS.ProcessEnv;
}): WindowsEditorInstallIo {
  const files = new Set((options.files ?? []).map((entry) => entry.toLowerCase()));
  return {
    env: options.env ?? {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    },
    pathExists: (candidate) => files.has(candidate.toLowerCase()),
    listDir: (dir) => options.dirs?.[dir] ?? [],
    registryApps: options.registryApps ?? [],
  };
}

describe("resolveWindowsEditorExecutable", () => {
  it("finds a system-wide install under Program Files", () => {
    const io = fakeIo({
      files: ["C:\\Program Files\\Microsoft VS Code\\Code.exe"],
      dirs: { "C:\\Program Files": ["Microsoft VS Code"] },
    });
    expect(resolveWindowsEditorExecutable("vscode", io)).toBe(
      "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    );
  });

  it("finds a per-user install under LOCALAPPDATA\\Programs", () => {
    const io = fakeIo({
      files: ["C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\Cursor.exe"],
      dirs: { "C:\\Users\\me\\AppData\\Local\\Programs": ["Cursor"] },
    });
    expect(resolveWindowsEditorExecutable("cursor", io)).toBe(
      "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\Cursor.exe",
    );
  });

  it("finds an executable under a bin subfolder", () => {
    const io = fakeIo({
      files: ["C:\\Program Files\\Android Studio\\bin\\studio64.exe"],
      dirs: { "C:\\Program Files": ["Android Studio"] },
    });
    expect(resolveWindowsEditorExecutable("android-studio", io)).toBe(
      "C:\\Program Files\\Android Studio\\bin\\studio64.exe",
    );
  });

  it("finds a JetBrains Toolbox release under ch-<build>", () => {
    const io = fakeIo({
      files: ["C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\apps\\WebStorm\\ch-0\\bin\\webstorm64.exe"],
      dirs: {
        "C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\apps\\WebStorm": ["ch-0"],
      },
    });
    expect(resolveWindowsEditorExecutable("webstorm", io)).toBe(
      "C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\apps\\WebStorm\\ch-0\\bin\\webstorm64.exe",
    );
  });

  it("finds a system JetBrains install by versioned folder prefix", () => {
    const io = fakeIo({
      files: ["C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.3\\bin\\idea64.exe"],
      dirs: { "C:\\Program Files\\JetBrains": ["IntelliJ IDEA 2024.3"] },
    });
    expect(resolveWindowsEditorExecutable("intellij-idea", io)).toBe(
      "C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.3\\bin\\idea64.exe",
    );
  });

  it("falls back to a registry InstallLocation", () => {
    const io = fakeIo({
      files: ["C:\\Program Files\\Sublime Text\\sublime_text.exe"],
      dirs: { "C:\\Program Files\\Sublime Text": [] },
      registryApps: [{ displayName: "Sublime Text 4", installLocation: "C:\\Program Files\\Sublime Text" }],
    });
    expect(resolveWindowsEditorExecutable("sublime-text", io)).toBe(
      "C:\\Program Files\\Sublime Text\\sublime_text.exe",
    );
  });

  it("uses a registry DisplayIcon path and strips its index suffix", () => {
    const io = fakeIo({
      files: ["C:\\Tools\\VSCodium\\VSCodium.exe"],
      registryApps: [{
        displayName: "VSCodium 1.99",
        displayIcon: "C:\\Tools\\VSCodium\\VSCodium.exe,0",
      }],
    });
    expect(resolveWindowsEditorExecutable("vscodium", io)).toBe("C:\\Tools\\VSCodium\\VSCodium.exe");
  });

  it("does not report an editor whose only candidate path is missing", () => {
    const io = fakeIo({
      files: [],
      dirs: { "C:\\Program Files": ["Microsoft VS Code"] },
      registryApps: [{ displayName: "Visual Studio Code", installLocation: "C:\\Gone" }],
    });
    expect(resolveWindowsEditorExecutable("vscode", io)).toBeNull();
  });

  it("has no Windows resolution for a macOS-only target", () => {
    const io = fakeIo({ files: ["C:\\Program Files\\Xcode\\xed.exe"] });
    expect(resolveWindowsEditorExecutable("xcode", io)).toBeNull();
  });
});

describe("parseRegistryUninstallOutput", () => {
  it("reads DisplayName, InstallLocation, and DisplayIcon across entries", () => {
    const output = [
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{a}",
      "    DisplayName    REG_SZ    Visual Studio Code",
      "    InstallLocation    REG_SZ    C:\\Program Files\\Microsoft VS Code\\",
      "    DisplayIcon    REG_SZ    C:\\Program Files\\Microsoft VS Code\\Code.exe,0",
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{b}",
      "    DisplayName    REG_SZ    Sublime Text 4",
      "",
    ].join("\r\n");
    expect(parseRegistryUninstallOutput(output)).toEqual([
      {
        displayName: "Visual Studio Code",
        installLocation: "C:\\Program Files\\Microsoft VS Code\\",
        displayIcon: "C:\\Program Files\\Microsoft VS Code\\Code.exe,0",
      },
      { displayName: "Sublime Text 4" },
    ]);
  });
});

describe("detectInstalledEditorTargets on win32", () => {
  it("records an off-PATH editor's executable so opening it does not need PATH", async () => {
    const seen: Array<{ command: string; args: string[] }> = [];
    const targets = await detectionTesting.detectInstalledEditorTargets({
      platform: "win32",
      env: {},
      commandSucceeds: async (command, args) => {
        seen.push({ command, args });
        return false;
      },
      resolveWindowsExecutable: async (target) =>
        target === "cursor" ? "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\Cursor.exe" : null,
    });
    expect(seen.every((entry) => entry.command === "where.exe")).toBe(true);
    expect(targets).toEqual(["cursor"]);
    expect(detectionTesting.resolveDetectedEditorCommand("cursor")).toBe(
      "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\Cursor.exe",
    );
  });

  it("lists Zed once when both the zed and zeditor targets resolve to one install", async () => {
    const zedExe = "C:\\Users\\me\\AppData\\Local\\Programs\\Zed\\zed.exe";
    const targets = await detectionTesting.detectInstalledEditorTargets({
      platform: "win32",
      env: {},
      commandSucceeds: async () => false,
      resolveWindowsExecutable: async (target) =>
        target === "zed" || target === "zeditor" ? zedExe : null,
    });
    expect(targets).toEqual(["zed"]);
    expect(detectionTesting.resolveDetectedEditorCommand("zed")).toBe(zedExe);
  });

  it("probes every editor concurrently rather than one after another", async () => {
    let started = 0;
    let maxConcurrent = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let allStartedResolve: () => void = () => {};
    const allStarted = new Promise<void>((resolve) => { allStartedResolve = resolve; });
    const pending = detectionTesting.detectInstalledEditorTargets({
      platform: "linux",
      env: {},
      commandSucceeds: async () => {
        started += 1;
        maxConcurrent = Math.max(maxConcurrent, started);
        if (started === EDITOR_TARGETS.length) allStartedResolve();
        await gate;
        return false;
      },
      resolveWindowsExecutable: async () => null,
    });
    await allStarted;
    releaseGate();
    await pending;
    // Every probe was in flight at the same moment; a serial loop would cap
    // concurrency at 1.
    expect(maxConcurrent).toBe(EDITOR_TARGETS.length);
  });
});

describe("findRegistryAppForSpec", () => {
  const app = (displayName: string) => ({ displayName });

  it("does not let vscode claim a Visual Studio Code - Insiders entry", () => {
    const vscode = installTesting.windowsEditorSpec("vscode")!;
    const insiders = installTesting.windowsEditorSpec("vscode-insiders")!;
    const apps = [app("Visual Studio Code - Insiders")];
    expect(installTesting.findRegistryAppForSpec(vscode, apps)).toBeNull();
    expect(installTesting.findRegistryAppForSpec(insiders, apps)?.displayName).toBe(
      "Visual Studio Code - Insiders",
    );
  });

  it("prefers an exact DisplayName over a contains match", () => {
    const vscode = installTesting.windowsEditorSpec("vscode")!;
    const apps = [app("Visual Studio Code - Insiders"), app("Visual Studio Code")];
    expect(installTesting.findRegistryAppForSpec(vscode, apps)?.displayName).toBe("Visual Studio Code");
  });
});
