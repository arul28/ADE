import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const runtimeRoot = path.join(desktopRoot, "resources", "runtime");
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

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

async function main() {
  for (const target of targets) {
    await validateExecutable(path.join(runtimeRoot, `ade-${target}`), `remote ADE service binary ${target}`);
    await statFile(
      path.join(runtimeRoot, `ade-${target}.native.tar.gz`),
      `remote ADE service native dependency archive ${target}`,
    );
  }

  console.log(`[runtime-resources] Found ${targets.length} remote ADE service binaries and native archives.`);
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
      "release CI uses the artifact download step.",
  );
  process.exit(1);
});
