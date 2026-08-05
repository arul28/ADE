// Assertions that hold for the packaged desktop tree on every platform.
//
// validate-win-artifacts.mjs and validate-mac-artifacts.mjs each grew their own
// copy of these: same size budgets, same agent-skill roster, same node-pty addon
// search, same "no runtime-fetched agent tool package may ship" rule. Two copies
// of a rule is one rule and one time bomb -- the OpenCode-only archive gate in
// release-core.yml had drifted exactly that way, and the app.asar embedding
// check below only ever existed on the Windows side.
//
// Everything here is a PURE extraction of what the two validators already did,
// with one deliberate exception noted on
// assertAsarEmbedsNoRuntimeFetchedToolPayload. Where the two had drifted, the
// difference is a named parameter rather than a silent unification: the message
// text and the order assertions fire in are part of each validator's contract
// with the humans who read its CI output.
//
// Both validators prefix their failures differently ("[validate-win-artifacts]"
// versus "[release:mac]"), so the caller injects its own `fail`; nothing here
// throws directly.

import fsp from "node:fs/promises";
import path from "node:path";
import asar from "@electron/asar";

import {
  runtimeFetchedToolPackageNames,
  RUNTIME_FETCHED_TOOL_EXPLANATION,
} from "./runtime-fetched-tool-packages.mjs";

/**
 * The agent skills ADE ships inside the package. Both validators carried this
 * list verbatim; a skill added to one and not the other would have shipped on
 * one platform only, which is the kind of gap nobody notices until a user on the
 * other platform reports a missing capability.
 */
export const BUNDLED_AGENT_SKILLS = Object.freeze([
  "ade-cli-control-plane",
  "ade-ios-simulator",
  "ade-app-control",
  "ade-browser",
  "ade-pr-workflows",
  "ade-lanes-git",
  "ade-linear",
  "ade-proof-artifacts",
  "ade-deeplinks",
  "ade-orchestrator",
]);

/** The JS entry points that must survive the runtime-fetched exclusions. */
const RUNTIME_TOOL_JS_ENTRY_POINTS = Object.freeze([
  { segments: ["opencode-ai"], label: "bundled OpenCode JS launcher" },
  { segments: ["@openai", "codex"], label: "bundled Codex JS launcher" },
  { segments: ["@anthropic-ai", "claude-agent-sdk"], label: "bundled Claude Agent SDK" },
]);

function collectAsarEmbeddedFiles(node, prefix, out) {
  for (const [name, entry] of Object.entries(node?.files ?? {})) {
    const entryPath = `${prefix}/${name}`;
    if (entry?.files) {
      collectAsarEmbeddedFiles(entry, entryPath, out);
    } else if (!entry?.unpacked) {
      // `unpacked: true` entries are index stubs; their bytes live in
      // app.asar.unpacked, not inside the archive.
      out.push({ path: entryPath, size: Number(entry?.size) || 0 });
    }
  }
}

/**
 * @param {{ fail: (message: string) => never | void }} options
 */
export function createPackagedTreeAssertions({ fail }) {
  if (typeof fail !== "function") {
    throw new Error("[validate-packaged-tree] createPackagedTreeAssertions requires a fail(message) reporter");
  }

  async function assertPathExists(targetPath, description) {
    try {
      await fsp.access(targetPath);
    } catch {
      fail(`Missing ${description}: ${targetPath}`);
    }
  }

  async function assertPathMissing(targetPath, description) {
    try {
      await fsp.access(targetPath);
    } catch {
      return;
    }
    fail(`Unexpected ${description}: ${targetPath}`);
  }

  async function assertBundledAgentSkills(agentSkillsRoot) {
    await assertPathExists(agentSkillsRoot, "bundled ADE agent skills root");
    for (const skillName of BUNDLED_AGENT_SKILLS) {
      await assertPathExists(
        path.join(agentSkillsRoot, skillName, "SKILL.md"),
        `bundled ADE agent skill ${skillName}`,
      );
    }
  }

  function readByteLimit(envName, fallback) {
    const rawValue = process.env[envName];
    if (!rawValue) return fallback;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      fail(`${envName} must be a positive byte count, received: ${rawValue}`);
    }
    return parsed;
  }

  async function computeRecursiveFileSize(rootPath) {
    let totalBytes = 0;
    let entries;
    try {
      entries = await fsp.readdir(rootPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(rootPath, entry.name);
      if (entry.isDirectory()) {
        totalBytes += await computeRecursiveFileSize(entryPath);
      } else if (entry.isFile()) {
        totalBytes += (await fsp.stat(entryPath)).size;
      }
    }

    return totalBytes;
  }

  /**
   * The app.asar and unpacked-tree size ceilings.
   *
   * The two validators differ only in wording and in how many unpacked trees
   * there are (Windows has one; a universal macOS bundle has a per-arch tree),
   * so both are parameters:
   *   - `subject` is appended to "is too large" ("" on Windows, " for <label>"
   *     on macOS, where one run validates several bundles).
   *   - `unpackedLabel` names the tree ("app.asar.unpacked" versus "unpacked
   *     runtime payload").
   * Callers pass their own limits because the defaults differ by platform and
   * by universal-versus-per-arch.
   */
  async function assertPackagedTreeSizeBudget({
    appAsarPath,
    unpackedPaths,
    maxAppAsarBytes,
    maxUnpackedBytes,
    unpackedLabel,
    subject = "",
  }) {
    const appAsarStat = await fsp.stat(appAsarPath);
    if (appAsarStat.size > maxAppAsarBytes) {
      fail(`app.asar is too large${subject}: ${appAsarStat.size} bytes (limit ${maxAppAsarBytes})`);
    }

    let unpackedBytes = 0;
    for (const unpackedPath of unpackedPaths) {
      unpackedBytes += await computeRecursiveFileSize(unpackedPath);
    }
    if (unpackedBytes > maxUnpackedBytes) {
      fail(`${unpackedLabel} is too large${subject}: ${unpackedBytes} bytes (limit ${maxUnpackedBytes})`);
    }
  }

  /**
   * The three fetched agent CLIs are single ~100-300 MB native executables per
   * platform. Dropping a package from `asarUnpack` without also excluding it in
   * `build.files` moves it *into* app.asar rather than removing it, which is
   * invisible in the unpacked-tree checks; this catches that regression.
   */
  async function assertAsarEmbedsNoRuntimeFetchedToolPayload(appAsarPath) {
    let header;
    try {
      header = asar.getRawHeader(appAsarPath).header;
    } catch (error) {
      fail(`Unable to read app.asar header for agent tool payload hygiene: ${error?.message ?? error}`);
      return;
    }
    const embedded = [];
    collectAsarEmbeddedFiles(header, "", embedded);
    // Exact package prefixes, never a wildcard: the JS entry points
    // (@anthropic-ai/claude-agent-sdk, @openai/codex, opencode-ai,
    // @opencode-ai/sdk) legitimately live in the archive and a prefix test on the
    // parent name would swallow them.
    const prefixes = runtimeFetchedToolPackageNames.map((name) => `/node_modules/${name}/`);
    const offenders = embedded.filter((entry) => prefixes.some((prefix) => entry.path.startsWith(prefix)));
    if (offenders.length === 0) return;
    const bytes = offenders.reduce((total, entry) => total + entry.size, 0);
    fail(
      `app.asar embeds ${offenders.length} runtime-fetched agent tool payload file(s) totalling ${bytes} bytes: `
      + `${offenders.slice(0, 5).map((entry) => entry.path).join(", ")}. `
      + RUNTIME_FETCHED_TOOL_EXPLANATION
      + " Exclude them via build.files.",
    );
  }

  /**
   * No native platform variant of Codex, Claude Code or OpenCode may ship - not
   * even the on-target arch, because every resolver consults the machine tools
   * cache first and would ignore a bundled copy.
   *
   * `report` preserves each validator's existing output. Windows fails on the
   * first offender it finds, naming that package; macOS collects them all and
   * lists them. Both are defensible and both are what their CI logs already
   * look like, so neither is quietly changed here.
   */
  async function assertNoRuntimeFetchedToolPackages({ nodeModulesPath, report, description }) {
    if (report === "first-offender") {
      for (const packageName of runtimeFetchedToolPackageNames) {
        await assertPathMissing(
          path.join(nodeModulesPath, ...packageName.split("/")),
          `runtime-fetched agent tool package ${packageName}`,
        );
      }
      return;
    }

    const offenders = [];
    for (const packageName of runtimeFetchedToolPackageNames) {
      const packagePath = path.join(nodeModulesPath, ...packageName.split("/"));
      try {
        await fsp.access(packagePath);
        offenders.push(packagePath);
      } catch {
        // absent, as required
      }
    }
    if (offenders.length > 0) {
      fail(
        `${description} ships ${offenders.length} runtime-fetched agent tool package(s):\n  `
        + `${offenders.join("\n  ")}\n${RUNTIME_FETCHED_TOOL_EXPLANATION}`,
      );
    }
  }

  /**
   * The mirror of the check above: an over-broad `!` exclusion in build.files
   * would take the JS SDK out along with its native siblings, and that breaks
   * the product rather than merely bloating it.
   *
   * `labelSuffix` is " package" on Windows and " for <bundle label>" on macOS,
   * which is the only way the two copies differed.
   */
  async function assertRuntimeToolJsEntryPointsPresent({ nodeModulesPath, labelSuffix }) {
    for (const { segments, label } of RUNTIME_TOOL_JS_ENTRY_POINTS) {
      await assertPathExists(path.join(nodeModulesPath, ...segments), `${label}${labelSuffix}`);
    }
  }

  /**
   * The bundled TUI is ESM. A bare `__dirname`/`__filename` in it throws at
   * import time in the packaged app, which is only reachable by reading the
   * file - there is no build step that would catch it.
   */
  function assertPackagedTuiEsmShims(contents) {
    for (const token of ["__dirname", "__filename"]) {
      if (contents.includes(token) && !contents.includes(`const ${token} =`)) {
        fail(`Bundled ADE code TUI references ${token} without an ESM shim`);
      }
    }
  }

  return {
    assertAsarEmbedsNoRuntimeFetchedToolPayload,
    assertBundledAgentSkills,
    assertNoRuntimeFetchedToolPackages,
    assertPackagedTreeSizeBudget,
    assertPackagedTuiEsmShims,
    assertPathExists,
    assertPathMissing,
    assertRuntimeToolJsEntryPointsPresent,
    computeRecursiveFileSize,
    readByteLimit,
  };
}

async function findFirstNodeAddon(rootPath) {
  const entries = await fsp.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findFirstNodeAddon(entryPath);
      if (nestedMatch) return nestedMatch;
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".node")) {
      return entryPath;
    }
  }

  return null;
}

/**
 * The packaged node-pty native addon, or null.
 *
 * `prebuildDirNames` is the one place the two validators differed: Windows
 * enumerates whatever is under `prebuilds/`, macOS names the two darwin
 * directories explicitly. Passing null keeps the enumerating behaviour.
 */
export async function findNodePtyAddon(moduleRootPath, { prebuildDirNames = null } = {}) {
  const candidateRoots = [
    path.join(moduleRootPath, "build", "Release"),
    path.join(moduleRootPath, "build", "Debug"),
  ];

  if (prebuildDirNames) {
    for (const dirName of prebuildDirNames) {
      candidateRoots.push(path.join(moduleRootPath, "prebuilds", dirName));
    }
  } else {
    try {
      const prebuildRoot = path.join(moduleRootPath, "prebuilds");
      const prebuildDirs = await fsp.readdir(prebuildRoot, { withFileTypes: true });
      for (const entry of prebuildDirs) {
        if (entry.isDirectory()) candidateRoots.push(path.join(prebuildRoot, entry.name));
      }
    } catch {
      // Keep the explicit candidate roots only.
    }
  }

  for (const candidateRoot of candidateRoots) {
    try {
      await fsp.access(candidateRoot);
    } catch {
      continue;
    }

    const addonPath = await findFirstNodeAddon(candidateRoot);
    if (addonPath) {
      return addonPath;
    }
  }

  return null;
}
