import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { compareUpdateVersions } from "../../../shared/updateVersions";

const exec = promisify(execFile);

/** Promote the bundled standalone runtime through the same transaction as `ade brain update`. */
export async function materializeAppImageRuntime(version: string): Promise<{ binary: string; env: NodeJS.ProcessEnv }> {
  const layout = resolveMachineAdeLayout();
  const target = `linux-${process.arch}`;
  if (process.arch !== "x64" && process.arch !== "arm64") throw new Error(`Unsupported Linux architecture: ${process.arch}`);
  const runtimeRoot = path.join(layout.runtimeDir, target);
  const binary = path.join(layout.binDir, "ade");
  const env: NodeJS.ProcessEnv = { ...process.env, ADE_HOME: layout.adeDir, ADE_DEFAULT_ROLE: "cto", ADE_RUNTIME_ROOT: runtimeRoot,
    ADE_RUNTIME_NODE_MODULES: path.join(runtimeRoot, "node_modules"), NODE_PATH: path.join(runtimeRoot, "node_modules"), ADE_CLI_VERSION: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.APPIMAGE;
  delete env.APPDIR;
  delete env.ADE_CLI_JS;
  delete env.ADE_RUNTIME_BUILD_HASH;
  for (const key of ["ADE_CHAT_SESSION_ID", "ADE_RUN_ID", "ADE_STEP_ID", "ADE_ATTEMPT_ID", "ADE_OWNER_ID"]) delete env[key];
  const hasInstalledBinary = await fs.access(binary).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (hasInstalledBinary) {
    // An unreadable existing install may be a newer headless brain. Never
    // replace it merely because its version or dependencies could not be read.
    await fs.access(path.join(runtimeRoot, "node_modules"));
    const current = await exec(binary, ["--version"], { env, timeout: 30_000 });
    const installed = current.stdout.trim().replace(/^ade\s+/i, "");
    if (!/^\d+\.\d+\.\d+/.test(installed)) throw new Error("Could not identify the existing ADE runtime version.");
    if (compareUpdateVersions(installed, version) >= 0) return { binary, env };
  }
  const source = path.join(process.resourcesPath, "runtime");
  await fs.mkdir(path.join(layout.runtimeDir, "updates"), { recursive: true });
  const staging = await fs.mkdtemp(path.join(layout.runtimeDir, "updates", "appimage-"));
  const stagedBinary = path.join(staging, "ade");
  const stagedRoot = path.join(staging, "runtime", target);
  const archive = path.join(source, `ade-${target}.native.tar.gz`);
  let applying = false;
  try {
    await fs.mkdir(stagedRoot, { recursive: true });
    await fs.copyFile(path.join(source, `ade-${target}`), stagedBinary);
    await fs.chmod(stagedBinary, 0o755);
    await exec("tar", ["-xzf", archive, "-C", stagedRoot], { timeout: 120_000 });
    const stagedEnv = { ...env, ADE_RUNTIME_ROOT: stagedRoot, ADE_RUNTIME_NODE_MODULES: path.join(stagedRoot, "node_modules"), NODE_PATH: path.join(stagedRoot, "node_modules") };
    const checked = await exec(stagedBinary, ["--version"], { env: stagedEnv, timeout: 30_000 });
    const stagedVersion = checked.stdout.trim().replace(/^ade\s+/i, "");
    if (stagedVersion !== version) throw new Error(`Bundled runtime version ${stagedVersion} does not match app ${version}.`);
    const manifest = path.join(staging, "manifest.json");
    await fs.writeFile(manifest, JSON.stringify({ version, repo: "arul28/ADE", target, adeHome: layout.adeDir,
      binaryPath: binary, runtimeTargetDir: runtimeRoot, stagedRuntimeRoot: stagedRoot, stagedBinaryPath: stagedBinary,
      nativeArchivePath: archive, restartService: false, createdAt: new Date().toISOString() }));
    applying = true;
    await exec(stagedBinary, ["brain", "update", "--apply-staged", manifest], {
      env: { ...stagedEnv, ADE_BRAIN_UPDATE_APPLY: "1" }, timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    return { binary, env };
  } catch (error) {
    // The update transaction may have retained recovery files here.
    if (!applying) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
