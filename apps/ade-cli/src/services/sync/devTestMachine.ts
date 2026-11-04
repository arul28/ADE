import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A dev test machine: a brain built from a lane checkout that runs on this
 * computer as a SEPARATE machine on the account, with sync on, so other
 * machines (a cloud box, the phone, the installed desktop) can reach a
 * branch's brain without replacing the installed one. Started by
 * `npm run dev:machine` (scripts/dev-machine.mjs).
 *
 * Everything that makes a machine a machine lives in its ADE home: the machine
 * key (relay tunnel), device id, signing key, account session, and the
 * account-directory hardware anchor, which hashes the home path. A brain on its
 * own home is therefore a different machine to everyone else. What is shared
 * with the installed brain is the computer itself, and that is all this file
 * guards:
 *
 * - The sync-host lease file is per OS user. A test machine takes its own
 *   lease in its home (ADE_SYNC_HOST_LOCK_PATH), and every brain's listener
 *   scan ignores a test machine's listener by the flag on its command line, so
 *   neither ever reports the other as a conflict or offers to quit it.
 * - Tailscale Serve is machine-wide config. A test machine publishes no
 *   tailnet route and never tidies one (ADE_TAILSCALE_SERVE=0); it is reached
 *   over the relay or the LAN.
 * - A project database is shared by path. A test machine refuses any project
 *   the installed ADE has registered, or a folder inside one (a lane
 *   worktree), because two brains with different device ids would both write
 *   it. Use a separate clone.
 */
export const DEV_TEST_MACHINE_FLAG = "--dev-test-machine";
export const DEV_TEST_MACHINE_ENV = "ADE_DEV_TEST_MACHINE";

/**
 * Written into a test machine's home by its launcher and its brain, so a plain
 * `ade` command against that home (which writes the project registry itself,
 * not through the brain) is held to the same project rule.
 */
export const DEV_TEST_MACHINE_MARKER_FILE = "dev-test-machine.json";

export function isDevTestMachineProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEV_TEST_MACHINE_ENV] === "1";
}

export function isDevTestMachineHome(adeDir: string): boolean {
  return fs.existsSync(path.join(adeDir, DEV_TEST_MACHINE_MARKER_FILE));
}

export function markDevTestMachineHome(adeDir: string): void {
  fs.mkdirSync(adeDir, { recursive: true });
  const marker = path.join(adeDir, DEV_TEST_MACHINE_MARKER_FILE);
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, `${JSON.stringify({ markedAt: new Date().toISOString() }, null, 2)}\n`);
  }
}

/** True for the command line of a brain started with `--dev-test-machine`, quoted or not. */
export function commandLineIsDevTestMachine(commandLine: string): boolean {
  return /(?:^|[\s"])--dev-test-machine(?=[\s"]|$)/.test(commandLine);
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "darwin" || process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(candidate: string, root: string): boolean {
  const child = pathKey(candidate);
  const parent = pathKey(root);
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

/**
 * Project roots registered in an ADE home's `projects.json`. Only a missing
 * file means "none"; a file that can't be read or parsed is unknown, and
 * treating it as empty would let a test machine open a project the installed
 * ADE serves, so that throws with a repair step.
 */
function registeredRoots(adeHome: string): string[] {
  const registryPath = path.join(adeHome, "projects.json");
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    throw unreadableRegistry(registryPath, error);
  }
  let parsed: { projects?: unknown };
  try {
    parsed = JSON.parse(raw) as { projects?: unknown };
  } catch (error) {
    throw unreadableRegistry(registryPath, error);
  }
  const projects = parsed && typeof parsed === "object" ? parsed.projects : undefined;
  if (projects !== undefined && !Array.isArray(projects)) {
    throw unreadableRegistry(registryPath, new Error("its project list is not a list"));
  }
  return ((projects ?? []) as Array<{ rootPath?: unknown } | null>)
    .map((project) => (typeof project?.rootPath === "string" ? project.rootPath : ""))
    .filter((rootPath) => rootPath.length > 0);
}

function unreadableRegistry(registryPath: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `This dev test machine cannot check which projects the installed ADE uses: ${registryPath} could not be read (${detail}). `
      + "Make that file readable (fix its permissions, or restore it if it is damaged), then try again.",
  );
}

/**
 * The installed ADE homes on this computer a test machine must stay out of:
 * the default home and the Alpha channel's.
 */
export function installedAdeHomes(): string[] {
  return [path.join(os.homedir(), ".ade"), path.join(os.homedir(), ".ade-alpha")];
}

/**
 * Throws when a dev test machine would open a project the installed ADE also
 * serves, or when it can't tell because an installed project list is unreadable.
 */
export function assertDevTestMachineMayOpenProject(
  rootPath: string,
  adeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isDevTestMachineProcess(env) && !isDevTestMachineHome(adeDir)) return;
  for (const home of installedAdeHomes()) {
    const shared = registeredRoots(home).find((root) => isSameOrInside(rootPath, root));
    if (shared) {
      throw new Error(
        `This dev test machine cannot open ${rootPath}: the installed ADE (${home}) already uses ${shared}, `
          + "and two machines would both write its project database. Give the test machine its own clone "
          + "(npm run dev:machine -- project --clone).",
      );
    }
  }
}
