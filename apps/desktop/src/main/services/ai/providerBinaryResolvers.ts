/**
 * Where each provider's runtime would find its own executable.
 *
 * One row per shipped provider, each delegating to the resolver that provider's
 * runtime already uses. No row does its own detection: a second detection path
 * would drift from the one that decides whether chat can start, and the status
 * screen would then disagree with the product.
 *
 * A row returns what it found and nothing more. The install rules the probe
 * loop applies to every row — a bare command name confirmed against PATH, an
 * execute-bit check, a `--version` spawn — live in `providerStatusProbe.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";
import { resolveCodexExecutable } from "./codexExecutable";
import { resolveDroidExecutable } from "./droidExecutable";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";
import { resolvePiInstallation } from "./piInstallation";
import type { ShippedProvider } from "../../../shared/providers";
import { CURSOR_CLI_EXECUTABLES } from "../../../shared/providerCliExecutables";
import { resolveOpenCodeBinaryPath } from "../opencode/openCodeBinaryManager";
import type {
  FsLike,
  ProbeContext,
  ProviderBinaryResolver,
  ResolvedProviderBinary,
} from "./providerProbeSeams";

/**
 * Anchored to this module, not to `process.cwd()`. Used to find `@cursor/sdk`
 * the way the Cursor runtime's own loader finds it.
 */
const moduleRequire = createRequire(
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
);

// ---------------------------------------------------------------------------
// Per-provider binary resolution
// ---------------------------------------------------------------------------

/**
 * Where `@cursor/sdk` actually is, resolved from THIS module.
 *
 * Anchored to `import.meta.url`, never to `process.cwd()`. A packaged runtime's
 * current directory is whatever the brain was started in — a user project, `/`,
 * a lane worktree — so a cwd-anchored lookup reported Cursor as not installed
 * on machines where Cursor chat works, and, worse, reported a user project's
 * own `node_modules` as Cursor's install path whenever that project happened to
 * depend on the package. This is the same resolution `loadCursorSdk()` uses.
 *
 * The walk up to the owning directory goes through the probe's filesystem seam,
 * so a test can steer Cursor's `installed` verdict the way it steers every
 * other provider's. `moduleRequire.resolve` is not steerable and does not need
 * to be: a seam that finds no `package.json` returns null either way.
 */
export function cursorSdkPackageDir(
  fsLike: Pick<FsLike, "existsSync"> = fs,
): string | null {
  let entry: string;
  try {
    // The package entry, not `@cursor/sdk/package.json`: the package declares an
    // `exports` map that does not expose its own manifest, so asking for it
    // throws ERR_PACKAGE_PATH_NOT_EXPORTED however the require is anchored.
    entry = moduleRequire.resolve("@cursor/sdk");
  } catch {
    return null;
  }
  // Walk up from the entry to the directory that owns it.
  let dir = path.dirname(entry);
  for (;;) {
    if (fsLike.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export const DEFAULT_RESOLVERS: Record<ShippedProvider, ProviderBinaryResolver> = {
  claude: (context) => {
    const resolved = resolveClaudeCodeExecutable({ env: context.env, platform: context.platform });
    return resolved.source === "fallback-command"
      ? { path: null, requiresPathConfirmation: true, command: resolved.path }
      : { path: resolved.path };
  },
  codex: (context) => {
    const resolved = resolveCodexExecutable({ env: context.env });
    return resolved.source === "fallback-command"
      ? { path: null, requiresPathConfirmation: true, command: resolved.path }
      : { path: resolved.path };
  },
  droid: (context) => {
    const resolved = resolveDroidExecutable({ env: context.env });
    return resolved.source === "fallback-command"
      ? { path: null, requiresPathConfirmation: true, command: resolved.path }
      : { path: resolved.path };
  },
  // No context argument: OpenCode's binary manager owns its own env handling
  // and its own cache, and re-implementing either would be a second detection
  // path that could disagree with the one that starts the server.
  opencode: async () => {
    try {
      const resolved = resolveOpenCodeBinaryPath();
      return resolved
        ? { path: resolved }
        : { path: null, requiresPathConfirmation: true, command: "opencode" };
    } catch {
      return { path: null, requiresPathConfirmation: true, command: "opencode" };
    }
  },
  pi: (context) => {
    const installation = resolvePiInstallation(context.env);
    const target = installation.cliPath ?? installation.packageRoot;
    if (!target) {
      return { path: null, detail: installation.blocker };
    }
    return {
      path: target,
      // Pi's version lives in the package manifest the resolver already read.
      // Spawning `pi --version` would pay a process for a value in hand.
      version: installation.version,
      skipVersionProbe: true,
      installedWithoutBinary: installation.cliPath == null,
      detail: installation.cliPath
        ? installation.blocker
        : `Pi's SDK package is installed at ${installation.packageRoot}; no \`pi\` CLI is on PATH.`,
    };
  },
  /**
   * Cursor is two things wearing one name. The chat runtime is the `@cursor/sdk`
   * Node package, not a binary; the `cursor-agent` CLI is a separate install
   * that only model discovery and the Work tab use. Either one means "Cursor
   * works here", so `installed` is the OR of them and `detail` says which was
   * found — a bare `installed: true` with a `node_modules` path would read as a
   * broken CLI detection.
   */
  cursor: (context) => {
    for (const candidate of CURSOR_CLI_EXECUTABLES.launchCandidates) {
      const found = resolveExecutableFromKnownLocations(candidate, context.env);
      if (found) {
        return { path: found.path, detail: `Cursor CLI (\`${candidate}\`) found on PATH.` };
      }
    }
    const packageDir = cursorSdkPackageDir(context.fs);
    if (packageDir) {
      return {
        path: packageDir,
        skipVersionProbe: true,
        installedWithoutBinary: true,
        detail: "Cursor runs through the @cursor/sdk Node package, not a CLI; the path is that package's directory.",
      };
    }
    return {
      path: null,
      detail: "Neither the @cursor/sdk package nor a `cursor-agent` CLI was found.",
    };
  },
};

