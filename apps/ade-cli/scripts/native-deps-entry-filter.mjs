// Per-package file filter for the runtime native dependency archive. Extracted
// from package-native-deps.mjs so the exclusions can be tested directly: the
// cost of getting one wrong is either a broken remote runtime or megabytes of
// dead weight in every desktop bundle.

import path from "node:path";

function targetParts(target) {
  const [platform, arch] = target.split("-");
  return { platform, arch };
}

// The three agent CLIs ADE drives -- Codex, Claude and OpenCode -- are fetched
// at runtime into the machine tools cache (~/.ade/tools, or %LOCALAPPDATA%\ADE\
// tools on Windows) at the versions pinned in
// apps/ade-cli/src/services/tools/toolsManifest.generated.json. Their native
// platform packages are the entire payload of those CLIs (~650 MB across the
// set), so shipping them in the runtime archive as well would double that cost
// to deliver bytes the brain then ignores in favour of the pinned cache copy.
//
// Only the NATIVE PLATFORM SIBLINGS are listed here. The JS entry points --
// @anthropic-ai/claude-agent-sdk (ADE calls query() on it in-process),
// @openai/codex, opencode-ai and @opencode-ai/sdk -- must keep shipping, so
// this is an exact-name set rather than a prefix match: a prefix test on
// "@anthropic-ai/claude-agent-sdk" would swallow the SDK itself.
//
// Exported because the packaged DESKTOP app has to exclude exactly the same
// set: apps/desktop/scripts/after-pack-runtime-fixes.cjs prunes and then hard-
// asserts on it, and both artifact validators check the packaged tree against
// it. Two hand-maintained copies of a 26-name list is precisely the drift that
// ships 600+ MB of dead binaries again, so there is only one list.
export const RUNTIME_FETCHED_TOOL_PACKAGES = new Set([
  "@openai/codex-darwin-arm64",
  "@openai/codex-darwin-x64",
  "@openai/codex-linux-arm64",
  "@openai/codex-linux-x64",
  "@openai/codex-win32-arm64",
  "@openai/codex-win32-x64",
  "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  "@anthropic-ai/claude-agent-sdk-darwin-x64",
  "@anthropic-ai/claude-agent-sdk-linux-arm64",
  "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
  "@anthropic-ai/claude-agent-sdk-linux-x64",
  "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
  "@anthropic-ai/claude-agent-sdk-win32-arm64",
  "@anthropic-ai/claude-agent-sdk-win32-x64",
  "opencode-darwin-arm64",
  "opencode-darwin-x64",
  "opencode-darwin-x64-baseline",
  "opencode-linux-arm64",
  "opencode-linux-arm64-musl",
  "opencode-linux-x64",
  "opencode-linux-x64-baseline",
  "opencode-linux-x64-baseline-musl",
  "opencode-linux-x64-musl",
  "opencode-windows-arm64",
  "opencode-windows-x64",
  "opencode-windows-x64-baseline",
]);

export function nodePtyPrebuildTarget(target) {
  const { platform, arch } = targetParts(target);
  if (platform === "darwin") return `darwin-${arch}`;
  if (platform === "linux") return `linux-${arch}`;
  return target;
}

export function shouldCopyPackageEntry(packageName, sourceRoot, entry, target) {
  // sql.js has no runtime consumer anywhere in this repo: production code uses
  // node:sqlite, and the only importers are six apps/desktop vitest files, which
  // is why it is a devDependency now. Excluding the whole package (19 MB, over
  // half of it debug asm builds) rather than only the -debug files keeps a
  // transitive reintroduction out of the runtime archive instead of trusting the
  // dependency walk alone. This is checked before the root guard below so the
  // package directory entry itself is rejected and fs.cp skips the whole tree.
  if (packageName === "sql.js") return false;

  // Same wholesale treatment, and for the same fs.cp reason, for the agent CLI
  // binaries the brain fetches into the pinned tools cache instead. Independent
  // of `target`: no target ships any of them.
  if (RUNTIME_FETCHED_TOOL_PACKAGES.has(packageName)) return false;

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

  if (packageName === "opencode-ai" && relative === "bin/opencode.exe" && !target.startsWith("win32-")) {
    return false;
  }

  return true;
}
