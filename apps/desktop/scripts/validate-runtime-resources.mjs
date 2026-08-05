import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import runtimeResourceTargets from "./runtime-resource-targets.cjs";

const {
  diffRuntimeArtifacts,
  formatRuntimeArtifactDiff,
  resolveRuntimeTargets,
  runtimeBinaryNameForTarget,
} = runtimeResourceTargets;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const runtimeRoot = path.join(desktopRoot, "resources", "runtime");
const execFileAsync = promisify(execFile);

const runtimeTargetSet = resolveRuntimeTargets();
const targets = runtimeTargetSet.targets;

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
  // A packaging job pinned to one target must contain that target and nothing
  // else. Foreign-platform sidecars are what pushed the macOS update zip past
  // the 1 GB Squirrel.Mac cliff, so they fail the build rather than ship.
  if (runtimeTargetSet.exclusive) {
    const diff = diffRuntimeArtifacts(runtimeRoot, targets);
    if (diff.missing.length > 0 || diff.unexpected.length > 0) {
      fail(formatRuntimeArtifactDiff(runtimeRoot, targets, diff));
    }
  }

  for (const target of targets) {
    await validateExecutable(
      path.join(runtimeRoot, runtimeBinaryNameForTarget(target)),
      `remote ADE service binary ${target}`,
    );
    await validateNativeArchive(path.join(runtimeRoot, `ade-${target}.native.tar.gz`), target);
  }

  console.log(
    `[runtime-resources] Found ${targets.length} ${runtimeTargetSet.mode} ADE service `
    + `binaries and native archives: ${targets.join(", ")}.`,
  );
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
