import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the Windows Apple Music host (`resources/native/ade-music-host/`).
 *
 * The host is a C# 5 WinForms program around WebView2 (see
 * `native/ADEMusicHostWin/src/AdeMusicHost.cs`). It needs no SDK:
 *
 *   - Compiler: the in-box .NET Framework 4 `csc.exe`, present on every
 *     Windows 10/11 machine, the release runner included.
 *   - WebView2 SDK: the `Microsoft.Web.WebView2` NuGet package, downloaded
 *     straight from nuget.org (a .nupkg is a zip) at a PINNED version and
 *     checked against NuGet's published SHA-512 before anything is used. No
 *     nuget.exe, no restore step, no project file.
 *
 * Output, all shipped by the `resources/native` extraResources entry:
 *   ade-music-host/ade-music-host.exe
 *   ade-music-host/Microsoft.Web.WebView2.Core.dll
 *   ade-music-host/Microsoft.Web.WebView2.WinForms.dll
 *   ade-music-host/WebView2Loader.dll        (x64)
 *   ade-music-host/page/index.html, player.js
 *
 * The WebView2 *runtime* is not bundled: Windows 11 ships the Evergreen runtime,
 * and the host reports `webview2_missing` when it is absent.
 */

const WEBVIEW2_VERSION = "1.0.4258.31";
// NuGet catalog `packageHash` for this version (SHA512, base64).
const WEBVIEW2_SHA512 = "HlGVwvyP/IWiXAU8K57Vmg59khY3DWMOxMnH4AHusFRy0/vDAjKItXUIVNXiXXaq4CLfSZyNUic1wOIlnPLsPQ==";
const WEBVIEW2_URL = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2_VERSION}/microsoft.web.webview2.${WEBVIEW2_VERSION}.nupkg`;

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(desktopRoot, "native", "ADEMusicHostWin");
const outputDir = path.join(desktopRoot, "resources", "native", "ade-music-host");
const cacheDir = path.join(desktopRoot, ".ade-native-build", "nuget");

if (process.platform !== "win32") {
  console.log("[music-host-win] Skipping outside Windows.");
  process.exit(0);
}
if (process.env.ADE_SKIP_MUSIC_HOST_BUILD === "1") {
  console.log("[music-host-win] Skipping (ADE_SKIP_MUSIC_HOST_BUILD=1).");
  process.exit(0);
}

const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
const csc = path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!fs.existsSync(csc)) {
  throw new Error(`[music-host-win] The .NET Framework 4 compiler is missing at ${csc}.`);
}

async function fetchWebView2Package() {
  fs.mkdirSync(cacheDir, { recursive: true });
  const nupkg = path.join(cacheDir, `microsoft.web.webview2.${WEBVIEW2_VERSION}.nupkg`);
  const verify = (file) =>
    crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64") === WEBVIEW2_SHA512;
  if (fs.existsSync(nupkg) && verify(nupkg)) return nupkg;
  console.log(`[music-host-win] Downloading Microsoft.Web.WebView2 ${WEBVIEW2_VERSION} from nuget.org.`);
  const response = await fetch(WEBVIEW2_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`[music-host-win] nuget.org answered HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const temporary = `${nupkg}.download`;
  fs.writeFileSync(temporary, bytes);
  if (!verify(temporary)) {
    fs.rmSync(temporary, { force: true });
    throw new Error("[music-host-win] The WebView2 package does not match its pinned SHA-512. Refusing to build.");
  }
  fs.renameSync(temporary, nupkg);
  return nupkg;
}

function extract(nupkg) {
  const dir = path.join(cacheDir, `microsoft.web.webview2.${WEBVIEW2_VERSION}`);
  const marker = path.join(dir, ".extracted");
  if (fs.existsSync(marker)) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // bsdtar ships in System32 since Windows 10 1803 and reads zip archives.
  const tar = path.join(windir, "System32", "tar.exe");
  execFileSync(fs.existsSync(tar) ? tar : "tar", ["-xf", nupkg, "-C", dir], { stdio: "inherit", windowsHide: true });
  fs.writeFileSync(marker, WEBVIEW2_VERSION);
  return dir;
}

const nupkg = await fetchWebView2Package();
const sdk = extract(nupkg);
const coreDll = path.join(sdk, "lib", "net462", "Microsoft.Web.WebView2.Core.dll");
const winFormsDll = path.join(sdk, "lib", "net462", "Microsoft.Web.WebView2.WinForms.dll");
const loaderDll = path.join(sdk, "runtimes", "win-x64", "native", "WebView2Loader.dll");
for (const file of [coreDll, winFormsDll, loaderDll]) {
  if (!fs.existsSync(file)) throw new Error(`[music-host-win] The WebView2 package has no ${path.relative(sdk, file)}.`);
}

const staging = fs.mkdtempSync(path.join(path.dirname(outputDir), "ade-music-host-"));
try {
  const exe = path.join(staging, "ade-music-host.exe");
  const result = spawnSync(csc, [
    "/nologo",
    "/target:winexe",
    "/platform:x64",
    "/optimize+",
    `/out:${exe}`,
    `/r:${coreDll}`,
    `/r:${winFormsDll}`,
    "/r:System.Windows.Forms.dll",
    "/r:System.Drawing.dll",
    path.join(sourceRoot, "src", "AdeMusicHost.cs"),
  ], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0 || !fs.existsSync(exe)) {
    throw new Error(`[music-host-win] csc failed (exit ${result.status}).`);
  }
  for (const file of [coreDll, winFormsDll, loaderDll]) fs.copyFileSync(file, path.join(staging, path.basename(file)));
  fs.cpSync(path.join(sourceRoot, "page"), path.join(staging, "page"), { recursive: true });
  // Swap in whole: a half-written host directory must never be what ships.
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.renameSync(staging, outputDir);
  console.log(`[music-host-win] Built ${path.relative(desktopRoot, outputDir)} (WebView2 SDK ${WEBVIEW2_VERSION}).`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
