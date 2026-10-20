/**
 * Where each provider's runtime would find its own executable.
 *
 * One row per shipped provider, each delegating to the resolver that provider's
 * runtime already uses. No row does its own detection: a second detection path
 * would drift from the one that decides whether chat can start, and the status
 * screen would then disagree with the product.
 *
 * Every row reports ADE's own pinned copy only. A provider CLI the user
 * installed never counts: nothing would spawn it. A miss carries the tools
 * cache's reason (downloading, failed, not available here) as `detail`.
 *
 * A row returns what it found and nothing more. The install rules the probe
 * loop applies to every row — an execute-bit check, a `--version` spawn —
 * live in `providerStatusProbe.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";
import { resolveCodexExecutable } from "./codexExecutable";
import { resolveDroidExecutable } from "./droidExecutable";
import { museBinaryBlocker, resolveMuseExecutable } from "./museExecutable";
import { resolvePiInstallation } from "./piInstallation";
import { pinnedToolState } from "./pinnedProviderTools";
import type { ShippedProvider } from "../../../shared/providers";
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

/** A row for a miss: no path, and the tools cache's reason. */
function pinnedMiss(tool: string, label: string): ResolvedProviderBinary {
  return { path: null, detail: pinnedToolState(tool, label).blocker };
}

export const DEFAULT_RESOLVERS: Record<ShippedProvider, ProviderBinaryResolver> = {
  claude: (context) => {
    const resolved = resolveClaudeCodeExecutable({ env: context.env, platform: context.platform });
    return resolved.source === "fallback-command" ? pinnedMiss("claude-code", "Claude Code") : { path: resolved.path };
  },
  codex: (context) => {
    const resolved = resolveCodexExecutable({ env: context.env });
    return resolved.source === "fallback-command" ? pinnedMiss("codex", "Codex") : { path: resolved.path };
  },
  droid: (context) => {
    const resolved = resolveDroidExecutable({ env: context.env });
    return resolved.source === "fallback-command" ? pinnedMiss("droid", "Droid") : { path: resolved.path };
  },
  // No context argument: OpenCode's binary manager owns its own env handling
  // and its own cache, and re-implementing either would be a second detection
  // path that could disagree with the one that starts the server.
  opencode: async () => {
    try {
      const resolved = resolveOpenCodeBinaryPath();
      return resolved ? { path: resolved } : pinnedMiss("opencode", "OpenCode");
    } catch {
      return pinnedMiss("opencode", "OpenCode");
    }
  },
  pi: (context) => {
    const installation = resolvePiInstallation(context.env);
    if (!installation.packageRoot) {
      return { path: null, detail: installation.blocker };
    }
    return {
      // Pi is a package ADE's Node imports, not a binary; its CLI is a script.
      path: installation.packageRoot,
      // Pi's version lives in the pin the resolver already read. Spawning
      // `pi --version` would pay a process for a value in hand.
      version: installation.version,
      skipVersionProbe: true,
      installedWithoutBinary: true,
      detail: installation.blocker,
    };
  },
  /**
   * Muse runs only from ADE's pinned build in the tools cache. A user's own
   * `muse` on PATH never counts as installed, because nothing will spawn it;
   * it is named in `detail` so the status screen does not look wrong to a
   * user who knows they installed Muse.
   */
  muse: (context) => {
    const target = { env: context.env, platform: context.platform, arch: context.arch };
    const resolved = resolveMuseExecutable(target);
    if (resolved.path) {
      return {
        path: resolved.path,
        version: resolved.pinnedVersion,
        // The pinned build is the version; spawning a 350 MB binary to echo it is waste.
        skipVersionProbe: resolved.source === "tools-cache",
      };
    }
    const userInstall = context.findOnPath("muse", context.env);
    const userNote = userInstall
      ? ` A separate Muse install was found at ${userInstall}; ADE does not use it.`
      : "";
    return { path: null, detail: `${museBinaryBlocker(resolved) ?? ""}${userNote}` };
  },
  /**
   * Cursor chat runs on the `@cursor/sdk` Node package ADE bundles, not on a
   * CLI, so the package is the install. A `cursor-agent` the user installed
   * does not count.
   */
  cursor: (context) => {
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
      detail: "ADE's bundled @cursor/sdk package was not found.",
    };
  },
};
