import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { spawn } from "node:child_process";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeModulesRoot = path.join(packageRoot, "node_modules");
const defaultOutDir = path.join(packageRoot, "dist-static");

function parseArgs(argv) {
  const args = { target: null, outDir: defaultOutDir };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--target") {
      args.target = argv[++i] ?? null;
    } else if (token === "--out-dir") {
      args.outDir = path.resolve(argv[++i] ?? "");
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  args.target ??= currentTarget();
  validateTarget(args.target);
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/package-native-deps.mjs [--target darwin-arm64] [--out-dir dist-static]\n`);
}

function currentTarget() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${platform}-${arch}`;
}

function validateTarget(target) {
  if (!/^(darwin|linux)-(arm64|x64)$/.test(target)) {
    throw new Error(`Unsupported runtime target '${target}'. Expected darwin-arm64, darwin-x64, linux-arm64, or linux-x64.`);
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function packagePath(packageName) {
  return path.join(nodeModulesRoot, ...packageName.split("/"));
}

async function readPackageManifest(packageName) {
  const manifestPath = path.join(packagePath(packageName), "package.json");
  if (!(await exists(manifestPath))) return null;
  return await readJson(manifestPath);
}

function isOpenCodePlatformPackage(packageName) {
  return /^opencode-(?:darwin|linux|windows)-/.test(packageName);
}

function targetParts(target) {
  const [platform, arch] = target.split("-");
  return { platform, arch };
}

function platformPackageTarget(packageName) {
  const patterns = [
    /^@openai\/codex-(darwin|linux|win32)-(arm64|x64)$/,
    /^@cursor\/sdk-(darwin|linux|win32)-(arm64|x64)$/,
    /^@anthropic-ai\/claude-agent-sdk-(darwin|linux)-(arm64|x64)(?:-musl)?$/,
    /^opencode-(darwin|linux|windows)-(arm64|x64)$/,
    /^@esbuild\/(darwin|linux|win32)-(arm64|x64)$/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(packageName);
    if (match) return { platform: match[1], arch: match[2] };
  }
  return null;
}

function isPackageForOtherTarget(packageName, target) {
  const packageTarget = platformPackageTarget(packageName);
  if (!packageTarget) return false;
  const targetPlatform = packageTarget.platform === "win32" || packageTarget.platform === "windows"
    ? "windows"
    : packageTarget.platform;
  const { platform, arch } = targetParts(target);
  return targetPlatform !== platform || packageTarget.arch !== arch;
}

function nodePtyPrebuildTarget(target) {
  const { platform, arch } = targetParts(target);
  if (platform === "darwin") return `darwin-${arch}`;
  if (platform === "linux") return `linux-${arch}`;
  return target;
}

function shouldCopyPackageEntry(packageName, sourceRoot, entry, target) {
  const relative = path.relative(sourceRoot, entry).split(path.sep).join("/");
  if (!relative || relative.startsWith("..")) return true;

  if (packageName === "node-pty") {
    if (relative.startsWith("prebuilds/")) {
      // The fs.cp filter receives the target directory entry itself
      // (e.g. "prebuilds/darwin-arm64") with no trailing slash. Returning
      // false for that entry would skip the ENTIRE subtree (pty.node +
      // spawn-helper), shipping an empty prebuilds/ and breaking PTY in the
      // remote runtime. Match the exact dir name as well as its contents.
      const prebuildDir = `prebuilds/${nodePtyPrebuildTarget(target)}`;
      return relative === "prebuilds" || relative === prebuildDir || relative.startsWith(`${prebuildDir}/`);
    }
    if (relative.startsWith("build/")) {
      return target.startsWith("linux-");
    }
  }

  if (packageName === "opencode-ai" && relative === "bin/opencode.exe") {
    return false;
  }

  return true;
}

async function collectRuntimePackages(target) {
  const rootManifest = await readJson(path.join(packageRoot, "package.json"));
  const platformCursorPackage = `@cursor/sdk-${target}`;
  const queue = [
    ...Object.keys(rootManifest.dependencies ?? {}),
    platformCursorPackage,
  ];
  const visited = new Set();
  const packages = [];

  while (queue.length > 0) {
    const packageName = queue.shift();
    if (!packageName || visited.has(packageName)) continue;
    if (isOpenCodePlatformPackage(packageName)) continue;
    if (isPackageForOtherTarget(packageName, target)) continue;
    visited.add(packageName);
    const manifest = await readPackageManifest(packageName);
    if (!manifest) continue;
    packages.push(packageName);

    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const dependencyName of Object.keys(deps)) {
      if (dependencyName.startsWith("@cursor/sdk-") && dependencyName !== platformCursorPackage) {
        continue;
      }
      if (isOpenCodePlatformPackage(dependencyName)) {
        continue;
      }
      if (isPackageForOtherTarget(dependencyName, target)) {
        continue;
      }
      if (!visited.has(dependencyName)) queue.push(dependencyName);
    }
  }

  return packages.sort((a, b) => a.localeCompare(b));
}

async function copyPackage(packageName, destinationRoot, target) {
  const source = packagePath(packageName);
  if (!(await exists(source))) return false;
  const destination = path.join(destinationRoot, "node_modules", ...packageName.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, {
    recursive: true,
    filter: (entry) => {
      const normalized = entry.split(path.sep).join("/");
      return !normalized.includes("/.cache/")
        && !normalized.includes("/test/")
        && !normalized.includes("/tests/")
        && !normalized.endsWith(".map")
        && shouldCopyPackageEntry(packageName, source, entry, target);
    },
  });
  return true;
}

async function writeManifest(bundleRoot, target, packages) {
  const manifest = {
    target,
    createdAt: new Date().toISOString(),
    packages,
  };
  await fs.writeFile(path.join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function chmodRuntimeExecutables(bundleRoot, target) {
  const executablePaths = [
    path.join(bundleRoot, "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(bundleRoot, "node_modules", `opencode-${target}`, "bin", "opencode"),
  ];
  if (target.startsWith("darwin-")) {
    executablePaths.push(path.join(bundleRoot, "node_modules", "node-pty", "prebuilds", target, "spawn-helper"));
  }
  for (const executablePath of executablePaths) {
    if (!(await exists(executablePath))) continue;
    const stat = await fs.stat(executablePath);
    await fs.chmod(executablePath, stat.mode | 0o111);
  }
}

async function makeTarGz(sourceDir, outputPath) {
  await fs.rm(outputPath, { force: true });
  const tar = spawn("tar", ["-cf", "-", "-C", sourceDir, "."], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let spawnError = null;
  tar.once("error", (error) => {
    spawnError = error;
    tar.stdout.destroy(error);
  });
  const out = createWriteStream(outputPath, { mode: 0o644 });
  try {
    await pipeline(tar.stdout, createGzip({ level: 9 }), out);
  } catch (error) {
    if (spawnError?.code === "ENOENT") {
      throw new Error("The 'tar' command is required to package native runtime dependencies.");
    }
    throw error;
  }
  const exitCode = await new Promise((resolve) => tar.once("close", resolve));
  if (exitCode !== 0) {
    throw new Error(`tar exited with status ${exitCode}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundleRoot = path.join(args.outDir, `ade-${args.target}.native`);
  await fs.rm(bundleRoot, { recursive: true, force: true });
  await fs.mkdir(bundleRoot, { recursive: true });

  const packageNames = await collectRuntimePackages(args.target);
  const copied = [];
  for (const packageName of packageNames) {
    if (await copyPackage(packageName, bundleRoot, args.target)) {
      copied.push(packageName);
    }
  }
  await chmodRuntimeExecutables(bundleRoot, args.target);
  await writeManifest(bundleRoot, args.target, copied);

  const archivePath = path.join(args.outDir, `ade-${args.target}.native.tar.gz`);
  await makeTarGz(bundleRoot, archivePath);
  if (process.env.ADE_KEEP_NATIVE_RUNTIME_STAGING !== "1") {
    await fs.rm(bundleRoot, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({
    target: args.target,
    archivePath,
    bundleRoot: process.env.ADE_KEEP_NATIVE_RUNTIME_STAGING === "1" ? bundleRoot : null,
    packages: copied,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[package-native-deps] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
