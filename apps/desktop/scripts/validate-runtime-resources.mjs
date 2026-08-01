import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const runtimeRoot = path.join(desktopRoot, "resources", "runtime");
const allTargets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const execFileAsync = promisify(execFile);

function currentTarget() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${platform}-${arch}`;
}

const allowHostOnlyRuntimeResources = process.env.ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY === "1";
const hostTarget = currentTarget();
const targets = allowHostOnlyRuntimeResources
  ? allTargets.includes(hostTarget) ? [hostTarget] : []
  : allTargets;

function fail(message) {
  throw new Error(`[runtime-resources] ${message}`);
}

async function statFile(filePath, label) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    fail(`Missing ${label}: ${filePath}`);
  }
  if (!stat.isFile()) {
    fail(`Expected ${label} to be a file: ${filePath}`);
  }
  if (stat.size <= 0) {
    fail(`Expected ${label} to be non-empty: ${filePath}`);
  }
  return stat;
}

async function validateExecutable(filePath, label) {
  const stat = await statFile(filePath, label);
  if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
    fail(`Expected ${label} to be executable: ${filePath}`);
  }
}

async function validateNativeArchive(filePath, target) {
  await statFile(filePath, `remote ADE service native dependency archive ${target}`);
  const { stdout } = await execFileAsync("tar", ["-tzf", filePath]);
  const entries = stdout.split(/\r?\n/);
  if (!entries.some((entry) => entry.startsWith("./node_modules/"))) {
    fail(`Remote runtime native archive for ${target} does not contain ./node_modules/: ${filePath}`);
  }
  if (!entries.includes("./tuiClient/cli.mjs")) {
    fail(`Remote runtime native archive for ${target} does not contain ./tuiClient/cli.mjs: ${filePath}`);
  }
}

async function main() {
  for (const target of targets) {
    await validateExecutable(path.join(runtimeRoot, `ade-${target}`), `remote ADE service binary ${target}`);
    await validateNativeArchive(path.join(runtimeRoot, `ade-${target}.native.tar.gz`), target);
  }

  const mode = allowHostOnlyRuntimeResources ? "host-only local" : "full";
  console.log(`[runtime-resources] Found ${targets.length} ${mode} ADE service binaries and native archives.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error(
    "[runtime-resources] Populate apps/desktop/resources/runtime with every " +
      "`ade-{darwin,linux}-{arm64,x64}` binary and matching `.native.tar.gz` archive. " +
      "Run `npm --prefix apps/desktop run materialize:runtime-resources` to copy downloaded artifacts " +
      "or build the local host target. For a direct local same-platform build, run " +
      "`npm --prefix apps/ade-cli run build:static -- --target <target> --out-dir ../desktop/resources/runtime`; " +
      "release CI uses the artifact download step. Local channel packages may set " +
      "ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY=1 to validate only the host target.",
  );
  process.exit(1);
});
