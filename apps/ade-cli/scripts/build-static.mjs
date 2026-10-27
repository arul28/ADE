import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runSentryCli, sourceMapsRequested, warn } from "../../../scripts/sentry/sentry-cli.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const desktopPackageJsonPath = path.join(repoRoot, "apps", "desktop", "package.json");
const cliPackageJsonPath = path.join(packageRoot, "package.json");
const defaultOutDir = path.join(packageRoot, "dist-static");
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function parseArgs(argv) {
  const args = {
    target: currentTarget(),
    outDir: defaultOutDir,
    skipBuild: false,
    skipNativeDeps: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      continue;
    } else if (token === "--target") {
      args.target = argv[++i] ?? "";
    } else if (token === "--out-dir") {
      args.outDir = path.resolve(argv[++i] ?? "");
    } else if (token === "--skip-build") {
      args.skipBuild = true;
    } else if (token === "--skip-native-deps") {
      args.skipNativeDeps = true;
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  validateTarget(args.target);
  return args;
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/build-static.mjs [--target darwin-arm64] [--out-dir dist-static]",
    "",
    "Builds an ADE runtime executable with Node SEA. Cross-target builds require",
    "ADE_STATIC_NODE_BINARY to point at a matching Node executable.",
    "",
  ].join("\n"));
}

function currentTarget() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${platform}-${arch}`;
}

function validateTarget(target) {
  if (!/^(?:(?:darwin|linux)-(?:arm64|x64)|win32-x64)$/.test(target)) {
    throw new Error(`Unsupported runtime target '${target}'. Expected darwin-arm64, darwin-x64, linux-arm64, linux-x64, or win32-x64.`);
  }
}

async function assertHostOrExplicitBinary(target) {
  if (target === currentTarget() || process.env.ADE_STATIC_NODE_BINARY) return;
  throw new Error(`Cannot build ${target} from ${currentTarget()} without ADE_STATIC_NODE_BINARY.`);
}

async function run(command, args, options = {}) {
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(command, args, {
      cwd: packageRoot,
      env: process.env,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: process.platform === "win32",
      ...options,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
    stderr = typeof error?.stderr === "string" ? error.stderr : "";
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    throw error;
  }
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

async function readPackageVersion(packageJsonPath) {
  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version.trim() : "";
  } catch {
    return "";
  }
}

async function resolveRuntimeVersion() {
  const explicit = process.env.ADE_CLI_VERSION?.trim();
  if (explicit) return explicit;

  const cliVersion = await readPackageVersion(cliPackageJsonPath);
  if (cliVersion && cliVersion !== "0.0.0") return cliVersion;

  const desktopVersion = await readPackageVersion(desktopPackageJsonPath);
  return desktopVersion || cliVersion || "0.0.0";
}

async function assertSeaCapableNodeBinary(binaryPath) {
  const contents = await fs.readFile(binaryPath);
  if (contents.includes(Buffer.from(fuse))) return;
  throw new Error([
    `Node binary '${binaryPath}' is not SEA-capable; it does not contain ${fuse}.`,
    "Use an official Node.js release binary for this target, or set ADE_STATIC_NODE_BINARY to one before running build:static.",
  ].join(" "));
}

/**
 * The oldest Node the runtime may embed. The headless runtime runs Pi's SDK
 * worker on its own Node, and Pi refuses anything older (`PI_SDK_MIN_NODE` in
 * apps/desktop/src/main/services/chat/piSdkProtocol.ts). Keep the two equal.
 */
const MIN_EMBEDDED_NODE = "22.19.0";

/** The first Node with `http.setGlobalProxyFromEnv`: an older runtime ignores HTTPS_PROXY. */
const PROXY_CAPABLE_NODE = "24.14.0";

function compareNodeVersions(left, right) {
  const a = left.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

/**
 * Refuse to embed a Node older than {@link MIN_EMBEDDED_NODE}. A binary built
 * for another target cannot run on this machine, so its version is not checked.
 */
async function assertEmbeddedNodeVersion(binaryPath, target) {
  let version = null;
  if (binaryPath === process.execPath) {
    version = process.version;
  } else if (target === currentTarget()) {
    version = (await execFileAsync(binaryPath, ["--version"], { cwd: packageRoot })).stdout.trim();
  }
  if (version === null) {
    process.stdout.write(`Not checking the Node version of ${binaryPath}: it is built for ${target}, not this machine.\n`);
    return;
  }
  if (compareNodeVersions(version, MIN_EMBEDDED_NODE) >= 0) {
    if (compareNodeVersions(version, PROXY_CAPABLE_NODE) < 0) {
      process.stdout.write(`Warning: embedding Node ${version}; a runtime older than ${PROXY_CAPABLE_NODE} ignores HTTPS_PROXY. Release builds use Node 24 (.nvmrc).\n`);
    }
    return;
  }
  throw new Error([
    `The headless runtime needs Node ${MIN_EMBEDDED_NODE} or newer, and ${binaryPath} is ${version}.`,
    "Run build:static with a newer Node, or set ADE_STATIC_NODE_BINARY to one.",
  ].join(" "));
}

/**
 * Locate signtool.exe. It ships with the Windows SDK and is normally absent
 * from PATH, so fall back to scanning the SDK's versioned bin directories and
 * take the newest. Returns null when no SDK is installed.
 */
async function resolveSignTool() {
  try {
    await run("signtool", ["/?"]);
    return "signtool";
  } catch {
    // Not on PATH; fall through to the SDK layout.
  }
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
    .filter(Boolean)
    .map((base) => path.join(base, "Windows Kits", "10", "bin"));
  for (const root of roots) {
    let versions = [];
    try {
      versions = (await fs.readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const version of versions) {
      for (const arch of ["x64", "x86"]) {
        const candidate = path.join(root, version, arch, "signtool.exe");
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          // Try the next SDK layout.
        }
      }
    }
  }
  return null;
}

/**
 * Strip the vendor signature before postject injects the SEA blob.
 *
 * Official Node.js releases are signed on BOTH macOS and Windows. postject
 * rewrites the executable, so a signature left in place ends up covering bytes
 * that no longer exist -- and the platform's signing tool then refuses to
 * re-sign the result. On Windows that surfaces as
 *
 *   SignTool Error: SignedCode::Sign returned error: 0x800700C1
 *
 * which is ERROR_BAD_EXE_FORMAT, i.e. "this is not a valid PE". Node's SEA
 * documentation requires removing the signature first on both platforms; only
 * the darwin half was ever implemented here, so every signed Windows runtime
 * build failed at the signing step.
 */
async function removeSignatureIfNeeded(binaryPath) {
  if (process.platform === "darwin") {
    try {
      await run("codesign", ["--remove-signature", binaryPath]);
    } catch {
      // Some Node builds are unsigned. postject can proceed in that case.
    }
    return;
  }

  if (process.platform === "win32") {
    const signTool = await resolveSignTool();
    if (!signTool) {
      // Only a signed release needs this; an unsigned local build is fine
      // without it, and failing here would break `build:static` on a dev box
      // that has no Windows SDK.
      console.warn(
        "[build-static] signtool.exe not found; skipping signature removal. "
        + "A signed release build requires the Windows SDK, or signing will "
        + "fail with 0x800700C1.",
      );
      return;
    }
    try {
      await run(signTool, ["remove", "/s", binaryPath]);
    } catch {
      // `remove /s` exits non-zero when the binary carries no signature, which
      // is the desired end state, so treat that as success.
    }
  }
}

async function adHocSignIfNeeded(binaryPath) {
  if (process.platform !== "darwin") return;
  await run("codesign", ["--sign", "-", binaryPath]);
}

async function assertStaticRuntimeVersion(binaryPath, expectedVersion, target) {
  if (target !== currentTarget()) return;
  const { stdout } = await execFileAsync(binaryPath, ["--version"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ADE_CLI_VERSION: "",
    },
  });
  const actual = stdout.trim().replace(/^ade\s+/i, "");
  if (actual !== expectedVersion) {
    throw new Error(`Static ADE runtime version mismatch: expected ${expectedVersion}, got ${actual || "<empty>"}.`);
  }
}

async function writeSeaEntry(workDir) {
  const cliPath = path.join(packageRoot, "dist", "cli.cjs");
  const seaEntryPath = path.join(workDir, "cli-sea.cjs");
  const cliSource = await fs.readFile(cliPath, "utf8");
  const banner = `\
var __adeSeaOriginalRequire = require;
var __adeSeaModule = __adeSeaOriginalRequire("module");
var __adeSeaPath = __adeSeaOriginalRequire("path");
var __adeSeaOs = __adeSeaOriginalRequire("os");
var __adeSeaFs = __adeSeaOriginalRequire("fs");
function __adeSeaTargetLabel() {
  var platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  var arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return platform + "-" + arch;
}
function __adeSeaRuntimeRootFromNodeModules(value) {
  if (!value) return null;
  return __adeSeaPath.basename(value) === "node_modules" ? __adeSeaPath.dirname(value) : value;
}
function __adeSeaDirectoryExists(value) {
  try {
    return __adeSeaFs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}
function __adeSeaCandidateRuntimeRoots() {
  var target = __adeSeaTargetLabel();
  var roots = [];
  var explicitRoot = process.env.ADE_RUNTIME_ROOT;
  var explicitNodeModules = process.env.ADE_RUNTIME_NODE_MODULES;
  if (explicitRoot) roots.push(explicitRoot);
  if (explicitNodeModules) roots.push(__adeSeaRuntimeRootFromNodeModules(explicitNodeModules));
  roots.push(__adeSeaPath.join(__adeSeaPath.dirname(process.execPath), "ade-" + target + ".native"));
  roots.push(__adeSeaPath.join(__adeSeaPath.dirname(process.execPath), "..", "runtime", target));
  if (process.env.NODE_PATH) {
    process.env.NODE_PATH.split(__adeSeaPath.delimiter).forEach(function (entry) {
      roots.push(__adeSeaRuntimeRootFromNodeModules(entry));
    });
  }
  roots.push(__adeSeaPath.join(__adeSeaOs.homedir(), ".ade", "runtime", target));
  return roots.filter(function (entry, index) {
    return Boolean(entry) && roots.indexOf(entry) === index;
  });
}
function __adeSeaResolveRuntimeRoot() {
  var roots = __adeSeaCandidateRuntimeRoots();
  for (var index = 0; index < roots.length; index += 1) {
    var root = roots[index];
    if (__adeSeaDirectoryExists(__adeSeaPath.join(root, "node_modules"))) return root;
  }
  return null;
}
var __adeSeaRuntimeRoot = __adeSeaResolveRuntimeRoot();
if (__adeSeaRuntimeRoot) {
  process.env.ADE_RESOLVED_RUNTIME_ROOT = __adeSeaRuntimeRoot;
  if (!process.env.ADE_RUNTIME_ROOT) process.env.ADE_RUNTIME_ROOT = __adeSeaRuntimeRoot;
  var __adeSeaRuntimeNodeModules = __adeSeaPath.join(__adeSeaRuntimeRoot, "node_modules");
  var __adeSeaNodePath = process.env.NODE_PATH || "";
  var __adeSeaNodePathParts = __adeSeaNodePath.split(__adeSeaPath.delimiter).filter(Boolean);
  if (!__adeSeaNodePathParts.includes(__adeSeaRuntimeNodeModules)) {
    process.env.NODE_PATH = [__adeSeaRuntimeNodeModules].concat(__adeSeaNodePathParts).join(__adeSeaPath.delimiter);
    if (typeof __adeSeaModule._initPaths === "function") __adeSeaModule._initPaths();
  }
}
var __adeSeaFilesystemRequire = __adeSeaModule.createRequire(
  __adeSeaRuntimeRoot ? __adeSeaPath.join(__adeSeaRuntimeRoot, ".ade-runtime.cjs") : process.execPath
);
var __adeSeaBuiltinModules = new Set(__adeSeaModule.builtinModules || []);
function __adeSeaIsBuiltinModuleId(id) {
  var bare = id.indexOf("node:") === 0 ? id.slice(5) : id;
  return __adeSeaBuiltinModules.has(id) || __adeSeaBuiltinModules.has(bare);
}
function __adeSeaIsBareModuleId(id) {
  return typeof id === "string"
    && id.length > 0
    && id.charAt(0) !== "."
    && !__adeSeaPath.isAbsolute(id)
    && !/^[A-Za-z]:[\\/]/.test(id);
}
function __adeSeaShouldUseFilesystemRequireFirst(id) {
  return Boolean(__adeSeaRuntimeRoot)
    && __adeSeaIsBareModuleId(id)
    && !__adeSeaIsBuiltinModuleId(id);
}
function __adeSeaCanFallbackAfterResolveError(error, id) {
  if (!error) return false;
  if (error.code === "ERR_UNKNOWN_BUILTIN_MODULE") return true;
  if (error.code !== "MODULE_NOT_FOUND") return false;
  var message = typeof error.message === "string" ? error.message : "";
  return message.indexOf("Cannot find module '" + id + "'") !== -1
    || message.indexOf("Cannot find module \\"" + id + "\\"") !== -1;
}
function __adeSeaRequire(id) {
  if (__adeSeaShouldUseFilesystemRequireFirst(id)) {
    try {
      return __adeSeaFilesystemRequire(id);
    } catch (error) {
      if (!__adeSeaCanFallbackAfterResolveError(error, id)) {
        throw error;
      }
    }
  }
  try {
    return __adeSeaOriginalRequire(id);
  } catch (error) {
    if (__adeSeaCanFallbackAfterResolveError(error, id)) {
      return __adeSeaFilesystemRequire(id);
    }
    throw error;
  }
}
Object.assign(__adeSeaRequire, __adeSeaOriginalRequire);
__adeSeaRequire.resolve = function __adeSeaRequireResolve(id, options) {
  if (__adeSeaShouldUseFilesystemRequireFirst(id)) {
    try {
      return __adeSeaFilesystemRequire.resolve(id, options);
    } catch (error) {
      if (!__adeSeaCanFallbackAfterResolveError(error, id)) {
        throw error;
      }
    }
  }
  try {
    return __adeSeaOriginalRequire.resolve(id, options);
  } catch (error) {
    if (__adeSeaCanFallbackAfterResolveError(error, id)) {
      return __adeSeaFilesystemRequire.resolve(id, options);
    }
    throw error;
  }
};
require = __adeSeaRequire;
var __adeSeaArgv1 = process.argv[1] || "";
if (!/(^|[/\\\\])cli\\.(?:ts|js|cjs)$/.test(__adeSeaArgv1)) {
  if (__adeSeaArgv1 === process.execPath || /(^|[/\\\\])ade(?:[-.]|$)/.test(__adeSeaArgv1)) {
    process.argv[1] = "cli.cjs";
  } else {
    process.argv.splice(1, 0, "cli.cjs");
  }
}
`;
  const droppedShebang = cliSource.startsWith("#!");
  const source = droppedShebang
    ? cliSource.replace(/^#!.*\n/u, "")
    : cliSource;
  const prefix = `${banner}\n`;
  await fs.writeFile(seaEntryPath, `${prefix}${source}`, "utf8");
  if (sourceMapsRequested()) await writeSeaSourceMap(workDir, seaEntryPath, cliPath, prefix, droppedShebang);
  return seaEntryPath;
}

/**
 * Release builds (ADE_BUILD_SOURCEMAPS=1): stamps the bundle with a Sentry
 * debug ID before it is wrapped, so the runtime's events name the map to use.
 * Never fails the build: a runtime without readable stack traces still ships.
 */
function stampBundleDebugId() {
  const cliPath = path.join(packageRoot, "dist", "cli.cjs");
  const result = runSentryCli(["sourcemaps", "inject", cliPath, `${cliPath}.map`], { capture: true });
  if (!result.ok) warn(`sentry-cli sourcemaps inject failed for the runtime bundle (exit ${result.status}): ${result.stderr.trim()}`);
}

/**
 * The source map for the SEA entry. The entry is the bundle behind the require
 * shim, so every line sits lower by the shim's line count (less the dropped
 * shebang); the map moves the bundle's by the same amount and keeps its debug
 * ID, which the stamped code still reports. Written with a copy of the entry
 * to `sentry/`, the pair `sentry-release.mjs upload --dir` sends. Never fails
 * the build.
 */
async function writeSeaSourceMap(workDir, seaEntryPath, cliPath, prefix, droppedShebang) {
  try {
    const map = JSON.parse(await fs.readFile(`${cliPath}.map`, "utf8"));
    if (!map.debugId && !map.debug_id) throw new Error("the bundle's map has no debug ID");
    const lines = map.mappings.split(";");
    // A shebang line carries no code; if it carried mappings, dropping it
    // would break the relative fields of the segments after it.
    if (droppedShebang && lines[0]) throw new Error("the bundle's map has mappings on its shebang line");
    map.mappings = ";".repeat(prefix.split("\n").length - 1) + lines.slice(droppedShebang ? 1 : 0).join(";");
    map.file = "cli-sea.cjs";
    const outDir = path.join(workDir, "sentry");
    await fs.mkdir(outDir, { recursive: true });
    const entry = await fs.readFile(seaEntryPath, "utf8");
    await fs.writeFile(
      path.join(outDir, "cli-sea.cjs"),
      entry.replace(/\/\/# sourceMappingURL=cli\.cjs\.map/u, "//# sourceMappingURL=cli-sea.cjs.map"),
      "utf8",
    );
    await fs.writeFile(path.join(outDir, "cli-sea.cjs.map"), JSON.stringify(map), "utf8");
  } catch (error) {
    warn(`No Sentry source map for the runtime: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertHostOrExplicitBinary(args.target);
  // Before the bundle build, so a too-old Node fails in seconds, not minutes.
  await assertEmbeddedNodeVersion(process.env.ADE_STATIC_NODE_BINARY || process.execPath, args.target);
  await fs.mkdir(args.outDir, { recursive: true });
  const runtimeVersion = await resolveRuntimeVersion();
  process.env.ADE_CLI_VERSION = runtimeVersion;

  if (!args.skipBuild) {
    if (process.platform === "win32") {
      const npmCli = process.env.npm_execpath
        || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      await run(process.execPath, [npmCli, "run", "build"]);
    } else {
      await run("npm", ["run", "build"]);
    }
  }

  if (sourceMapsRequested()) stampBundleDebugId();

  const workDir = path.join(args.outDir, ".sea", args.target);
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });
  const seaEntryPath = await writeSeaEntry(workDir);
  const sourceNodeBinary = process.env.ADE_STATIC_NODE_BINARY || process.execPath;
  await assertSeaCapableNodeBinary(sourceNodeBinary);

  const seaConfigPath = path.join(workDir, "sea-config.json");
  const blobPath = path.join(workDir, "ade.blob");
  const seaConfig = {
    main: seaEntryPath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    // Node 24's V8 sizes the young generation by the machine's memory, which
    // left an idle brain ~55 MB larger than on Node 22. 16 MB is Node 22's
    // cap; collection cost is unchanged from the Node 22 runtime. An older
    // Node ignores the field.
    execArgv: ["--max-semi-space-size=16"],
  };
  await fs.writeFile(seaConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`, "utf8");
  await run(sourceNodeBinary, ["--experimental-sea-config", seaConfigPath]);

  const binaryName = `ade-${args.target}${args.target.startsWith("win32-") ? ".exe" : ""}`;
  const binaryPath = path.join(args.outDir, binaryName);
  await fs.copyFile(sourceNodeBinary, binaryPath);
  await fs.chmod(binaryPath, 0o755);
  await removeSignatureIfNeeded(binaryPath);

  const postjectArgs = [
    binaryPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    fuse,
  ];
  if (args.target.startsWith("darwin-")) {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  if (process.platform === "win32") {
    await run(process.execPath, [path.join(packageRoot, "node_modules", "postject", "dist", "cli.js"), ...postjectArgs]);
  } else {
    await run(path.join(packageRoot, "node_modules", ".bin", "postject"), postjectArgs);
  }
  await adHocSignIfNeeded(binaryPath);

  let nativeArchivePath = null;
  const nativeStagingRoot = path.join(args.outDir, `ade-${args.target}.native`);
  const shouldRemoveNativeStaging = !args.skipNativeDeps && process.env.ADE_KEEP_NATIVE_RUNTIME_STAGING !== "1";

  try {
    if (!args.skipNativeDeps) {
      await run(process.execPath, [
        path.join(packageRoot, "scripts", "package-native-deps.mjs"),
        "--target",
        args.target,
        "--out-dir",
        args.outDir,
      ], {
        env: {
          ...process.env,
          ADE_KEEP_NATIVE_RUNTIME_STAGING: "1",
        },
      });
      nativeArchivePath = path.join(args.outDir, `ade-${args.target}.native.tar.gz`);
    }

    await assertStaticRuntimeVersion(binaryPath, runtimeVersion, args.target);
  } finally {
    if (shouldRemoveNativeStaging) {
      await fs.rm(nativeStagingRoot, { recursive: true, force: true });
    }
    if (process.env.ADE_KEEP_STATIC_RUNTIME_STAGING !== "1") {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  process.stdout.write(`${JSON.stringify({
    target: args.target,
    binaryPath,
    nativeArchivePath,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[build-static] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
