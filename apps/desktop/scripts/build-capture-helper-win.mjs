import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the Windows half of the global capture helper.
 *
 * Skips cleanly off Windows for exactly the reason `build-attention-notch.mjs`
 * skips off macOS: the source is Win32 C++ against the Windows SDK and cannot
 * be cross-compiled from a Mac, so a `dist:mac` run on a developer machine must
 * not fail because the other platform's helper is missing. What ships is
 * whatever `resources/native` holds, and the top-level `extraResources` filter
 * lists both names — so the Mac package ships only `ade-capture-helper` and the
 * Windows package only `ade-capture-helper.exe`, with no per-platform config.
 *
 * Two toolchains are accepted, in order:
 *   1. MSVC `cl.exe` — what the release box has, via a Developer Command Prompt
 *      or after `vcvarsall.bat`.
 *   2. `clang++` / `g++` targeting mingw-w64 — what a contributor is likely to
 *      have. Same source, same flags in spirit.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const sourcePath = path.join(desktopRoot, "native", "ADECaptureHelperWin", "src", "main.cpp");
const outputRoot = path.join(desktopRoot, "resources", "native");
const outputPath = path.join(outputRoot, "ade-capture-helper.exe");

if (process.platform !== "win32") {
  console.log("[capture-helper-win] Skipping Windows capture helper build outside Windows.");
  process.exit(0);
}

if (process.env.ADE_SKIP_CAPTURE_HELPER_BUILD === "1") {
  console.log("[capture-helper-win] Skipping Windows capture helper build (ADE_SKIP_CAPTURE_HELPER_BUILD=1).");
  process.exit(0);
}

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Missing capture helper source: ${sourcePath}`);
}

fs.mkdirSync(outputRoot, { recursive: true });

// Every spawn below passes `windowsHide: true`, including the two bare probes.
// Omitting it is the documented Windows failure in `WINDOWS_PORT.md`: a console
// window flashes up for each probe and can outlive the run that opened it.
let compilerEnv = process.env;
function hasTool(command) {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", shell: false, windowsHide: true, env: compilerEnv });
  if (!probe.error) return true;
  // cl.exe has no --version and exits non-zero on a bare invocation, but it
  // still runs; `error` is only set when the executable could not be spawned.
  const bare = spawnSync(command, [], { stdio: "ignore", shell: false, windowsHide: true, env: compilerEnv });
  return !bare.error;
}

// Match the Windows Desktop driver build: ordinary shells can discover the
// installed MSVC/SDK environment without a Developer Command Prompt.
if (!hasTool("cl.exe")) {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (fs.existsSync(vswhere)) {
    const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", windowsHide: true }).trim();
    const devCommand = path.join(installation, "Common7", "Tools", "VsDevCmd.bat");
    if (installation && fs.existsSync(devCommand) && !/["\r\n%]/.test(devCommand)) {
      const environment = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"call "${devCommand}" -arch=x64 -host_arch=x64 >nul && set"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
      compilerEnv = { ...process.env };
      for (const line of environment.split(/\r?\n/)) {
        const equals = line.indexOf("=");
        if (equals > 0) {
          const key = line.slice(0, equals);
          // Windows treats environment names as case-insensitive. Passing
          // both PATH and Path makes Node select one and can discard MSVC.
          for (const existing of Object.keys(compilerEnv)) {
            if (existing.toLowerCase() === key.toLowerCase()) delete compilerEnv[existing];
          }
          compilerEnv[key] = line.slice(equals + 1);
        }
      }
    }
  }
}

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-capture-helper-"));
const temporaryOutput = path.join(scratchDir, "ade-capture-helper.exe");

try {
  if (hasTool("cl.exe")) {
    console.log("[capture-helper-win] Building with MSVC cl.exe.");
    execFileSync("cl.exe", [
      "/nologo",
      "/std:c++17",
      "/EHsc",
      "/O2",
      "/DUNICODE",
      "/D_UNICODE",
      // /MT rather than /MD: the helper is copied next to the app as a bare
      // .exe with no redistributable beside it, so it must not depend on a
      // VC runtime DLL the target machine may not have.
      "/MT",
      sourcePath,
      `/Fe:${temporaryOutput}`,
      `/Fo:${path.join(scratchDir, "main.obj")}`,
      "/link",
      "/SUBSYSTEM:CONSOLE",
    ], { stdio: "inherit", cwd: scratchDir, windowsHide: true, env: compilerEnv });
  } else {
    const compiler = hasTool("clang++") ? "clang++" : hasTool("g++") ? "g++" : null;
    if (!compiler) {
      throw new Error(
        "No C++ toolchain found. Install the Visual Studio Build Tools (cl.exe) or mingw-w64 (g++/clang++), "
        + "or set ADE_SKIP_CAPTURE_HELPER_BUILD=1 to package without the capture gesture.",
      );
    }
    console.log(`[capture-helper-win] Building with ${compiler}.`);
    execFileSync(compiler, [
      "-std=c++17",
      "-O2",
      // No `-municode`: the entry point is a plain `main`, and -municode would
      // make the linker look for `wmain` and fail.
      "-DUNICODE",
      "-D_UNICODE",
      sourcePath,
      "-o", temporaryOutput,
      // `#pragma comment(lib, ...)` is MSVC-only, so the mingw path has to name
      // every import library itself.
      "-lgdiplus", "-lgdi32", "-luser32", "-ldwmapi", "-lole32",
      "-static",
    ], { stdio: "inherit", cwd: scratchDir, windowsHide: true, env: compilerEnv });
  }

  if (!fs.existsSync(temporaryOutput)) {
    throw new Error(`The C++ build did not produce ${temporaryOutput}`);
  }
  fs.copyFileSync(temporaryOutput, outputPath);
  console.log(
    `[capture-helper-win] Materialized ${path.relative(desktopRoot, outputPath)}.`,
  );
} finally {
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
