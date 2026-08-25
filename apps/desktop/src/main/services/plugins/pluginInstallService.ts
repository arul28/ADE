import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { Logger } from "../logging/logger";
import { isPathInside } from "../shared/pathCompare";
import { preferNativeExecutablePath } from "../shared/processExecution";
import { dirExists, nowIso, spawnAsync, writeTextAtomic } from "../shared/utils";
import {
  isPluginSupportedByAdeVersion,
  isValidPluginId,
  parsePluginManifestJson,
  type PluginManifest,
} from "../../../shared/plugins/manifest";
import {
  requiresChecksumVerification,
  verifyPluginChecksum,
  type PluginRegistryEntry,
} from "../../../shared/plugins/registryIndex";
import type { PluginInstallRecord } from "../../../shared/plugins/sdk";
import { emitPluginChange } from "./pluginEvents";
import {
  pluginRegistryFilePath,
  readPluginRegistryContents,
  resolvePluginsRoot,
  type PluginRegistryFileContents,
} from "./pluginRegistryFile";

// Re-exported because this module is where the resolver used to live and every
// install-side caller already imports it from here; it now sits next to the
// reader so a consumer that only reads the registry does not have to pull the
// install service in.
export { resolvePluginsRoot };

const PLUGIN_MANIFEST_FILE = "plugin.json";

/**
 * `git`, named so Windows spawns it directly.
 *
 * `spawnAsync` routes an EXTENSION-LESS command through `cmd.exe /d /s /c`
 * (windows-quirks §8), which re-parses the whole command line: a clone URL
 * containing `%…%` would expand against the environment and a ref could pick up
 * `cmd` metacharacters. Naming the `.exe` keeps the argv structured, which is
 * the only form these arguments are safe in.
 */
const GIT_COMMAND = preferNativeExecutablePath(["git", "git.exe"]) ?? "git";

/**
 * Copy ceilings. A plugin is source code and a few JSON schemas; a repository
 * that trips either of these is a data dump or a build output tree, and copying
 * it into `~/.ade/plugins` would put an unbounded amount of the user's disk
 * behind an install action they cannot see the size of.
 */
const PLUGIN_INSTALL_MAX_BYTES = 64 * 1024 * 1024;
const PLUGIN_INSTALL_MAX_FILES = 5_000;

/** Never copied: version control metadata and dependency trees. */
const PLUGIN_COPY_EXCLUDED_DIRS = new Set([".git", "node_modules"]);

const PLUGIN_GIT_CLONE_TIMEOUT_MS = 120_000;

/** Archiving an already-local shallow clone is disk work, not network work. */
const PLUGIN_GIT_ARCHIVE_TIMEOUT_MS = 30_000;

/**
 * Git sources are matched, not sanitized. The URL reaches `git` as one argv
 * element (never a shell), but a leading `-` would still be read as a flag and
 * `--upload-pack=…` is remote code execution, so the scheme prefix is required.
 */
const PLUGIN_GIT_URL_PATTERN = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@)[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{1,512}$/;

/** Branch/tag/sha. No `..`, no leading dash, no whitespace. */
const PLUGIN_GIT_REF_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,128}$/;

/**
 * What the directory says about one plugin, as of the call that asked.
 *
 * `absent` and `unreachable` are the distinction the install gate turns on:
 * "the directory answered and does not list this plugin" is a fact an install
 * may act on, while "nobody answered" is the absence of information — and
 * treating the second as the first silently installs official plugins with no
 * checksum check at all on any machine that has not browsed the Marketplace.
 */
export type PluginRegistryVerificationRead =
  | { status: "entry"; entry: Pick<PluginRegistryEntry, "official" | "checksums"> }
  | { status: "absent" }
  | { status: "unreachable" };

export type PluginInstalledPlugin = {
  record: PluginInstallRecord;
  /** `null` when `plugin.json` is missing or unparseable — install still lists. */
  manifest: PluginManifest | null;
  /** `<pluginsRoot>/<pluginId>` */
  root: string;
  errors: string[];
  warnings: string[];
};

export type PluginInstallService = {
  readonly root: string;
  list(): PluginInstalledPlugin[];
  get(pluginId: string): PluginInstalledPlugin | null;
  install(args: { source: string; ref?: string; enable?: boolean }): Promise<PluginInstalledPlugin>;
  uninstall(pluginId: string): { removed: boolean };
  setEnabled(pluginId: string, enabled: boolean): PluginInstalledPlugin;
  /** Persist one socket contribution's on/off state in the install registry. */
  setContributionEnabled(pluginId: string, socketId: string, enabled: boolean): PluginInstalledPlugin;
  /**
   * Re-read the plugin from disk (the `ade plugin dev` loop).
   *
   * A `local`-source plugin is re-copied from the folder it was installed from
   * first, so an edit there is what the restarted child runs. A resync that had
   * to be refused arrives as a warning on the returned plugin, never silently.
   */
  reload(pluginId: string): PluginInstalledPlugin;
  /**
   * The version of the package this ADE SHIPS for an id, or null if it ships
   * none. Callers that only have an id — a phone, the web client, another
   * machine's Marketplace — ask this to find out whether "install it" can be
   * answered from this disk instead of from a repository.
   */
  bundledPackageVersion(pluginId: string): string | null;
  /** Absolute skill directories that exist, enabled plugins only. */
  skillRoots(): string[];
};

/** The registry file's shape, read and written here. */
type PluginRegistryFile = PluginRegistryFileContents;


/**
 * The sha256 the directory vouches for, computed the directory's way.
 *
 * The recipe is fixed in `registry/README.md` — `git archive` of the tag,
 * excluding `.git`, through sha256 — and it has to be reproduced EXACTLY or
 * every official plugin fails to install. That is why this shells out to `git`
 * over the clone instead of walking the tree: any hand-rolled traversal would
 * be a second, subtly different definition of "the source tree", and the
 * disagreement would only ever show up on a real official release.
 *
 * Returns null when the staged tree is not a git clone (a local-directory
 * install), which is never an official-registry source. `-o` writes the archive
 * to a file rather than a pipe: `spawnAsync` caps captured output, and a
 * truncated tar would hash to a confident wrong answer.
 */
async function gitArchiveDigest(stagingDir: string, logger: Logger): Promise<string | null> {
  if (!dirExists(path.join(stagingDir, ".git"))) return null;
  const tarPath = path.join(path.dirname(stagingDir), `.archive-${randomUUID()}.tar`);
  try {
    const result = await spawnAsync(
      GIT_COMMAND,
      // `core.autocrlf` is per-machine and on by default on Windows, and it
      // rewrites line endings INSIDE the archive — so the same tag would digest
      // differently there than on the machine that published the digest, and
      // the one check that must never cry wolf would report tampering. Pinned
      // here and in `registry/README.md`'s published recipe.
      ["-C", stagingDir, "-c", "core.autocrlf=false", "archive", "--format=tar", "-o", tarPath, "HEAD"],
      { timeout: PLUGIN_GIT_ARCHIVE_TIMEOUT_MS, maxOutputBytes: 8_000 },
    );
    if (result.status !== 0) {
      logger.warn("plugin.checksum_archive_failed", { stderr: result.stderr.trim().slice(0, 200) });
      return null;
    }
    const hash = createHash("sha256");
    hash.update(fs.readFileSync(tarPath));
    return hash.digest("hex");
  } catch (error) {
    logger.warn("plugin.checksum_archive_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    try {
      fs.rmSync(tarPath, { force: true });
    } catch {
      // The archive is scratch; failing to remove it must not fail an install.
    }
  }
}

function readManifestAt(pluginRoot: string): { manifest: PluginManifest | null; errors: string[]; warnings: string[] } {
  let text: string;
  try {
    text = fs.readFileSync(path.join(pluginRoot, PLUGIN_MANIFEST_FILE), "utf8");
  } catch (error) {
    return {
      manifest: null,
      errors: [`${PLUGIN_MANIFEST_FILE} could not be read: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
  return parsePluginManifestJson(text);
}

/** Resolve a plugin's install directory, refusing anything outside the root. */
function pluginRootWithin(root: string, pluginId: string): string {
  if (!isValidPluginId(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  const resolved = path.resolve(root, pluginId);
  const relative = path.relative(root, resolved);
  if (relative !== pluginId || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to resolve plugin "${pluginId}" outside ${root}.`);
  }
  return resolved;
}

/**
 * Copy a plugin source tree, enforcing the file/byte ceilings as it walks so a
 * runaway directory is refused before the disk fills rather than after.
 * Symlinks are skipped outright: following one would copy content from outside
 * the source tree into a directory the user believes mirrors a repository.
 */
function copyPluginTree(source: string, target: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const visit = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (PLUGIN_COPY_EXCLUDED_DIRS.has(entry.name)) continue;
        visit(path.join(from, entry.name), path.join(to, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const sourceFile = path.join(from, entry.name);
      const size = fs.statSync(sourceFile).size;
      files += 1;
      bytes += size;
      if (files > PLUGIN_INSTALL_MAX_FILES) {
        throw new Error(`Plugin source has more than ${PLUGIN_INSTALL_MAX_FILES} files; refusing to install.`);
      }
      if (bytes > PLUGIN_INSTALL_MAX_BYTES) {
        throw new Error(
          `Plugin source is larger than ${Math.round(PLUGIN_INSTALL_MAX_BYTES / (1024 * 1024))} MiB; refusing to install.`,
        );
      }
      fs.copyFileSync(sourceFile, path.join(to, entry.name));
    }
  };
  visit(source, target);
  return { files, bytes };
}

function measureClonedTree(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (PLUGIN_COPY_EXCLUDED_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      bytes += fs.statSync(path.join(dir, entry.name)).size;
    }
  };
  visit(root);
  return { files, bytes };
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Best effort: a staging directory left behind is inert.
  }
}

/**
 * Where ADE's own bundled plugin packages live.
 *
 * Packaged builds carry them beside the bundled agent skills (`extraResources`,
 * see `apps/desktop/package.json`); a source checkout has them at the repo's
 * `plugins/`.
 *
 * These packages are discoverable for an explicit bare-id install; resolving
 * the directory never installs, copies, enables, or runs one. The packaged path
 * is anchored to `resourcesPath`, and the source path is accepted only at a
 * directory that proves it is THIS repository.
 */
export function resolveBuiltinPluginsRoot(
  env: NodeJS.ProcessEnv = process.env,
  /** Injected by the test that pins the walk; production reads the process. */
  from: { cwd?: string; dirname?: string | null; resourcesPath?: string | null } = {},
): string | null {
  const configured = env.ADE_BUILTIN_PLUGINS_DIR?.trim();
  if (configured) return dirExists(configured) ? configured : null;
  // Tests opt in by passing `builtinPluginsRoot` explicitly so a bare-id test
  // cannot accidentally resolve packages from the checkout running Vitest.
  if (env.VITEST || env.VITEST_WORKER_ID || env.NODE_ENV === "test") return null;
  const resourcesPath = from.resourcesPath
    ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    ?? null;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "plugins");
    if (dirExists(packaged)) return packaged;
  }
  const starts = [
    from.cwd ?? process.cwd(),
    from.dirname === undefined ? (typeof __dirname === "string" ? __dirname : null) : from.dirname,
  ];
  for (const start of starts) {
    if (!start) continue;
    let current = start;
    for (let depth = 0; depth < BUILTIN_PLUGINS_ANCESTOR_DEPTH; depth += 1) {
      const candidate = path.join(current, "plugins");
      if (isAdePluginsSourceRoot(current) && dirExists(candidate)) return candidate;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

/** How far up from `cwd`/`__dirname` a dev checkout's root may sit. */
const BUILTIN_PLUGINS_ANCESTOR_DEPTH = 8;

/** `package.json` `name` at this repository's root. */
const ADE_REPO_PACKAGE_NAME = "ade";

/**
 * Is this directory the ADE checkout itself?
 *
 * The marker is the workspace `package.json` name, which no unrelated parent
 * directory carries. Without it the walk could accept an unrelated ancestor's
 * `plugins/` directory as ADE's explicit-install catalogue.
 */
function isAdePluginsSourceRoot(directory: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as { name?: unknown };
    return parsed.name === ADE_REPO_PACKAGE_NAME;
  } catch {
    return false;
  }
}

export type BuiltinPluginPackage = { pluginId: string; source: string; manifest: PluginManifest };

/**
 * Bundled package directories that carry a readable, valid manifest.
 *
 * Explicit install looks one category deep so the bundled starter themes can
 * be addressed by id. A directory with a manifest is a package and is never
 * descended into, so a category cannot shadow a package.
 */
const BUILTIN_CATEGORY_MAX_DEPTH = 1;

function listBuiltinPackages(builtinRoot: string, maxDepth = BUILTIN_CATEGORY_MAX_DEPTH): BuiltinPluginPackage[] {
  const packages: BuiltinPluginPackage[] = [];
  const visit = (directory: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const source = path.join(directory, entry.name);
      const parsed = readManifestAt(source);
      if (!parsed.manifest || parsed.errors.length > 0) {
        // No manifest here: a grouping directory, so look inside it if this
        // caller is allowed to.
        if (depth < maxDepth) visit(source, depth + 1);
        continue;
      }
      // A bundled package that does not parse is a build problem, not a user
      // problem; omit it from the explicit-install catalogue.
      if (!isValidPluginId(entry.name) || parsed.manifest.name !== entry.name) continue;
      packages.push({ pluginId: entry.name, source, manifest: parsed.manifest });
    }
  };
  visit(builtinRoot, 0);
  return packages.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

/**
 * What `install` will actually do with a `source` string, decided WITHOUT
 * putting anything on the machine.
 *
 * Exported because the in-chat install approval has to describe the install
 * before it runs, and a second reading of the same string is how a card ends up
 * promising one thing while the install does another. This is the same branch
 * `install` itself takes, in the same order — local directory first, then the
 * bundled catalogue, then git — so the two cannot disagree.
 *
 * A git URL resolves with no manifest by design: reading it would mean cloning
 * it, and describing a source must never be the step that fetches code.
 */
export type PluginInstallSourceResolution =
  | { kind: "path"; path: string; manifest: PluginManifest | null }
  | { kind: "builtin"; pluginId: string; path: string; manifest: PluginManifest }
  | { kind: "git"; url: string };

export function resolvePluginInstallSource(
  source: string,
  options: { builtinPluginsRoot?: string | null } = {},
): PluginInstallSourceResolution | null {
  const trimmed = source?.trim();
  if (!trimmed) return null;
  const builtinRoot = options.builtinPluginsRoot === undefined
    ? resolveBuiltinPluginsRoot()
    : options.builtinPluginsRoot;
  const isLocalDirectory = !PLUGIN_GIT_URL_PATTERN.test(trimmed) && dirExists(path.resolve(trimmed));
  if (isLocalDirectory) {
    const resolved = path.resolve(trimmed);
    const parsed = readManifestAt(resolved);
    // A directory whose manifest does not parse still resolves as a path: the
    // install will fail on the same manifest a moment later, and saying "this
    // is a directory I cannot read" is more use than calling it a git URL.
    return { kind: "path", path: resolved, manifest: parsed.errors.length > 0 ? null : parsed.manifest };
  }
  if (builtinRoot && isValidPluginId(trimmed)) {
    const bundled = listBuiltinPackages(builtinRoot).find((entry) => entry.pluginId === trimmed);
    if (bundled) {
      return { kind: "builtin", pluginId: bundled.pluginId, path: bundled.source, manifest: bundled.manifest };
    }
  }
  if (PLUGIN_GIT_URL_PATTERN.test(trimmed)) return { kind: "git", url: trimmed };
  // Neither a directory here, nor a package this build ships, nor a URL shaped
  // like one git would accept. `install` would reject it too.
  return null;
}

export function createPluginInstallService(deps: {
  logger: Logger;
  pluginsRoot?: string;
  adeVersion?: string | null;
  /**
   * What the directory says about a plugin, confirmed on THIS call.
   *
   * Injected rather than imported so this service never fetches anything
   * itself. The three answers are not interchangeable — see
   * {@link PluginRegistryVerificationRead}.
   */
  resolveRegistryEntry?: (pluginId: string) => Promise<PluginRegistryVerificationRead>;
  /**
   * Tell the directory an install happened. Fire-and-forget by contract: the
   * install has already succeeded by the time this runs, and telemetry that can
   * fail an install is worse than telemetry that is occasionally missing.
   */
  reportInstall?: (install: { pluginId: string; version: string }) => void | Promise<void>;
  /** Bundled plugin packages available for explicit install by id. */
  builtinPluginsRoot?: string | null;
  /**
   * Runs after the manifest is parsed (so the id being replaced is known) and
   * before the staged tree is renamed over an existing install.
   *
   * Every source kind stages to a temp directory first and only reveals its
   * plugin id once that staged manifest is read — a git clone or a bundled
   * copy names its id no earlier than a local directory does. Wired to
   * `pluginHostService`'s `stopSupervisor` so a running child is never left
   * holding a handle into the directory this function is about to rename: on
   * Windows that handle makes the rename fail outright, and everywhere else
   * the old process keeps answering requests while the new version is already
   * reported installed.
   */
  beforeReplace?: (pluginId: string) => void | Promise<void>;
}): PluginInstallService {
  const root = deps.pluginsRoot?.trim() || resolvePluginsRoot();
  const statePath = pluginRegistryFilePath(root);
  const builtinRoot = deps.builtinPluginsRoot === undefined
    ? resolveBuiltinPluginsRoot()
    : deps.builtinPluginsRoot;

  /** The bundled package for an id, when this build ships one. */
  const findBuiltinPackage = (pluginId: string): BuiltinPluginPackage | null => {
    if (!builtinRoot || !isValidPluginId(pluginId)) return null;
    return listBuiltinPackages(builtinRoot).find((entry) => entry.pluginId === pluginId) ?? null;
  };

  const readRegistry = (): PluginRegistryFile => readPluginRegistryContents(root);

  const writeRegistry = (registry: PluginRegistryFile): void => {
    try {
      writeTextAtomic(statePath, `${JSON.stringify(registry, null, 2)}\n`);
    } catch (error) {
      deps.logger.error("plugin.registry_write_failed", {
        statePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const describe = (record: PluginInstallRecord): PluginInstalledPlugin => {
    const pluginRoot = path.join(root, record.pluginId);
    const parsed = readManifestAt(pluginRoot);
    return { record, manifest: parsed.manifest, root: pluginRoot, errors: parsed.errors, warnings: parsed.warnings };
  };

  const list = (): PluginInstalledPlugin[] => {
    // REGISTRY, never `readdirSync(root)`. A directory nobody installed is not
    // a plugin, and the cache-vs-registry discipline here is the same one
    // `claudeOutputStyles.ts` applies to Claude's managed plugin directories.
    const registry = readRegistry();
    return Object.values(registry.plugins)
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
      .map(describe);
  };

  /**
   * The record for an id, or null.
   *
   * `Object.hasOwn` rather than a bare index: the id reaches this from a phone,
   * a URL and a plugin's own SDK call, and `plugins["constructor"]` on a plain
   * object answers with a function that then fails somewhere far less
   * explicable than here.
   */
  const findRecord = (registry: PluginRegistryFile, pluginId: string): PluginInstallRecord | null => (
    Object.hasOwn(registry.plugins, pluginId) ? registry.plugins[pluginId] ?? null : null
  );

  const get = (pluginId: string): PluginInstalledPlugin | null => {
    const record = findRecord(readRegistry(), pluginId);
    return record ? describe(record) : null;
  };

  const requireRecord = (pluginId: string): { registry: PluginRegistryFile; record: PluginInstallRecord } => {
    const registry = readRegistry();
    const record = findRecord(registry, pluginId);
    if (!record) throw new Error(`Plugin "${pluginId}" is not installed.`);
    return { registry, record };
  };

  const stageFromLocalDirectory = (source: string, stagingDir: string): void => {
    const stats = copyPluginTree(source, stagingDir);
    deps.logger.debug("plugin.install_copied", { source, files: stats.files, bytes: stats.bytes });
  };

  const stageFromGit = async (url: string, ref: string | undefined, stagingDir: string): Promise<void> => {
    if (!PLUGIN_GIT_URL_PATTERN.test(url)) throw new Error(`Unsupported plugin git URL: ${url}`);
    if (ref !== undefined && !PLUGIN_GIT_REF_PATTERN.test(ref)) throw new Error(`Unsupported plugin git ref: ${ref}`);
    // `spawnAsync` is the house spawner: no `shell: true`, a real timeout, and
    // a process-tree kill when the clone hangs on an unreachable host.
    const result = await spawnAsync(
      GIT_COMMAND,
      ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--", url, stagingDir],
      { timeout: PLUGIN_GIT_CLONE_TIMEOUT_MS, maxOutputBytes: 8_000 },
    );
    if (result.status !== 0) {
      throw new Error(`git clone failed for ${url}: ${result.stderr.trim() || `exit ${String(result.status)}`}`);
    }
    const stats = measureClonedTree(stagingDir);
    if (stats.files > PLUGIN_INSTALL_MAX_FILES) {
      throw new Error(`Cloned plugin has more than ${PLUGIN_INSTALL_MAX_FILES} files; refusing to install.`);
    }
    if (stats.bytes > PLUGIN_INSTALL_MAX_BYTES) {
      throw new Error(
        `Cloned plugin is larger than ${Math.round(PLUGIN_INSTALL_MAX_BYTES / (1024 * 1024))} MiB; refusing to install.`,
      );
    }
  };

  /**
   * Refuse a staged tree whose bytes disagree with the digest the directory
   * published for this version.
   *
   * Runs while the plugin is still in staging, so a tampered tree is never
   * moved into place and never runs.
   *
   * Three answers, three outcomes, and folding any two of them together breaks
   * the gate:
   *
   * - **entry** — verify against the published digest. An OFFICIAL entry with
   *   no digest for the requested version is REFUSED rather than installed
   *   unverified: picking a version the directory has not vouched for is
   *   otherwise a free pass around the whole check.
   * - **absent**, or a community entry — unverified, and that is permanent.
   *   The directory does not checksum community plugins, and failing them would
   *   make it a gate on installing anything at all.
   * - **unreachable** — nobody answered, which is NOT "no checksum published".
   *   A plugin presenting itself as official is refused with a message that
   *   says so; a community plugin still installs, so an offline machine keeps
   *   working. The manifest's own `official` claim is all there is to go on
   *   here, and reading it can only ADD refusals: a plugin that lies about
   *   being official gets refused, and one that lies the other way was never
   *   going to be verified anyway.
   */
  const verifyStagedTree = async (stagingDir: string, manifest: PluginManifest): Promise<void> => {
    if (!deps.resolveRegistryEntry) return;
    let read: PluginRegistryVerificationRead;
    try {
      read = await deps.resolveRegistryEntry(manifest.name);
    } catch {
      read = { status: "unreachable" };
    }
    if (read.status === "unreachable") {
      if (!manifest.official) return;
      throw new Error(
        `Plugin "${manifest.name}" ${manifest.version} says it is an official plugin, and ADE could not reach `
        + "the plugin directory to check it against the published checksum. Try again when you are online.",
      );
    }
    if (read.status === "absent") return;
    const entry = read.entry;
    if (entry.official && !requiresChecksumVerification(entry, manifest.version)) {
      throw new Error(
        `Plugin "${manifest.name}" is official, but the directory publishes no checksum for version `
        + `${manifest.version}. Refusing to install a version ADE cannot vouch for.`,
      );
    }
    if (!requiresChecksumVerification(entry, manifest.version)) return;
    const actual = await gitArchiveDigest(stagingDir, deps.logger);
    if (!actual) {
      throw new Error(
        `Plugin "${manifest.name}" ${manifest.version} is an official release with a published checksum, `
        + "but this install has no git archive to verify against it.",
      );
    }
    const verdict = verifyPluginChecksum({ entry, version: manifest.version, actual });
    if (verdict.kind === "mismatch") {
      deps.logger.error("plugin.checksum_mismatch", {
        pluginId: manifest.name,
        version: manifest.version,
        expected: verdict.expected,
        actual: verdict.actual,
      });
      throw new Error(
        `Plugin "${manifest.name}" ${manifest.version} does not match the checksum ADE publishes for it. `
        + "Refusing to install.",
      );
    }
    deps.logger.info("plugin.checksum_verified", { pluginId: manifest.name, version: manifest.version });
  };

  const install = async (args: { source: string; ref?: string; enable?: boolean }): Promise<PluginInstalledPlugin> => {
    const source = args.source?.trim();
    if (!source) throw new Error("A plugin source path or git URL is required.");
    fs.mkdirSync(root, { recursive: true });

    const isLocalDirectory = !PLUGIN_GIT_URL_PATTERN.test(source) && dirExists(path.resolve(source));
    // A bare plugin id names a BUNDLED package: the starter themes and the two
    // pilots ship inside ADE, so the honest source for them is the copy on this
    // disk, not a repository URL that has to resolve over the network. Checked
    // after the directory test so a real directory of the same name still wins.
    const bundled = isLocalDirectory ? null : findBuiltinPackage(source);
    const stagingDir = path.join(root, `.staging-${randomUUID()}`);
    let manifest: PluginManifest;
    let warnings: string[];
    try {
      if (isLocalDirectory) {
        stageFromLocalDirectory(path.resolve(source), stagingDir);
      } else if (bundled) {
        stageFromLocalDirectory(bundled.source, stagingDir);
      } else {
        await stageFromGit(source, args.ref, stagingDir);
      }
      const parsed = readManifestAt(stagingDir);
      if (!parsed.manifest || parsed.errors.length > 0) {
        throw new Error(
          `Plugin manifest is invalid: ${parsed.errors.join("; ") || `${PLUGIN_MANIFEST_FILE} is missing`}`,
        );
      }
      if (!isValidPluginId(parsed.manifest.name)) {
        throw new Error(`Plugin manifest name "${parsed.manifest.name}" is not a valid plugin id.`);
      }
      if (!isPluginSupportedByAdeVersion(parsed.manifest, deps.adeVersion)) {
        throw new Error(
          `Plugin "${parsed.manifest.name}" requires ADE ${parsed.manifest.minAdeVersion} or newer.`,
        );
      }
      // A bundled package skips the directory entirely. The digest gate exists
      // to check bytes that arrived over the NETWORK against what the directory
      // vouches for; these bytes arrived inside ADE's own signed app, and there
      // is nothing further to compare them to. Without this the official
      // pilots and starter themes are uninstallable by every path at once —
      // they are `official: true` with no published checksum until release
      // tagging, which the gate below correctly refuses for a downloaded tree.
      if (!bundled) await verifyStagedTree(stagingDir, parsed.manifest);
      manifest = parsed.manifest;
      warnings = parsed.warnings;
    } catch (error) {
      removeQuietly(stagingDir);
      throw error;
    }

    const pluginId = manifest.name;
    const target = pluginRootWithin(root, pluginId);
    const previous = `${target}.previous-${randomUUID()}`;
    const hadPrevious = dirExists(target);
    // Between parsing the manifest (this is the first point the id this
    // install is REPLACING is known, for every source kind) and the rename
    // below that moves the staged tree over it.
    if (hadPrevious) {
      try {
        await deps.beforeReplace?.(pluginId);
      } catch (error) {
        removeQuietly(stagingDir);
        throw error;
      }
    }
    try {
      if (hadPrevious) fs.renameSync(target, previous);
      fs.renameSync(stagingDir, target);
    } catch (error) {
      // Put the working install back before surfacing the failure — a failed
      // upgrade must not leave the user with no plugin at all.
      if (hadPrevious && !dirExists(target) && dirExists(previous)) {
        try {
          fs.renameSync(previous, target);
        } catch {
          // Nothing further to try; the error below carries the real cause.
        }
      }
      removeQuietly(stagingDir);
      throw error;
    }
    removeQuietly(previous);

    const registry = readRegistry();
    const existing = registry.plugins[pluginId];
    const at = nowIso();
    const record: PluginInstallRecord = {
      pluginId,
      version: manifest.version,
      enabled: args.enable === undefined ? existing?.enabled !== false : args.enable,
      source: bundled
        // Recorded as builtin because the source was this build's catalogue;
        // future updates remain explicit and never overwrite it automatically.
        ? { kind: "builtin" }
        : isLocalDirectory
          ? { kind: "local", path: path.resolve(source) }
          : { kind: "git", url: source, ...(args.ref ? { ref: args.ref } : {}) },
      installedAt: existing?.installedAt ?? at,
      updatedAt: at,
      // Reinstalling (an upgrade, or the `ade plugin dev` loop) must not switch
      // a contribution the user turned off back on: the OFF list is their
      // setting, and it survives the code being replaced under it.
      ...(existing?.disabledContributions?.length
        ? { disabledContributions: [...existing.disabledContributions] }
        : {}),
    };
    registry.plugins[pluginId] = record;
    writeRegistry(registry);
    deps.logger.info("plugin.installed", {
      pluginId,
      version: record.version,
      source: record.source.kind,
      warnings: warnings.length,
    });
    emitPluginChange({ kind: "installs", pluginId });
    // After the install is committed, and never awaited: the directory's
    // install counts are worth having, and not at the cost of making a
    // successful install look slow or — if the relay is down — failed.
    if (deps.reportInstall) {
      void (async () => {
        try {
          await deps.reportInstall?.({ pluginId, version: record.version });
        } catch (error) {
          deps.logger.debug("plugin.install_ping_failed", {
            pluginId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }
    return { record, manifest, root: target, errors: [], warnings };
  };

  const uninstall = (pluginId: string): { removed: boolean } => {
    const registry = readRegistry();
    const existing = findRecord(registry, pluginId);
    const known = existing !== null;
    let target: string;
    try {
      target = pluginRootWithin(root, pluginId);
    } catch (error) {
      deps.logger.warn("plugin.uninstall_refused", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { removed: false };
    }
    if (dirExists(target)) removeQuietly(target);
    if (known) {
      delete registry.plugins[pluginId];
      writeRegistry(registry);
    }
    deps.logger.info("plugin.uninstalled", { pluginId, known });
    if (known) emitPluginChange({ kind: "installs", pluginId });
    return { removed: known };
  };

  const setEnabled = (pluginId: string, enabled: boolean): PluginInstalledPlugin => {
    const { registry, record } = requireRecord(pluginId);
    const next: PluginInstallRecord = { ...record, enabled, updatedAt: nowIso() };
    registry.plugins[pluginId] = next;
    writeRegistry(registry);
    deps.logger.info("plugin.enabled_changed", { pluginId, enabled });
    emitPluginChange({ kind: "installs", pluginId });
    return describe(next);
  };

  const setContributionEnabled = (
    pluginId: string,
    socketId: string,
    enabled: boolean,
  ): PluginInstalledPlugin => {
    const id = socketId?.trim();
    if (!id) throw new Error("A contribution id is required.");
    const { registry, record } = requireRecord(pluginId);
    const disabled = new Set(record.disabledContributions ?? []);
    // Stored as the OFF list, so a contribution the manifest adds later is on
    // by default rather than silently absent — see PluginSummary's docblock.
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    const next: PluginInstallRecord = {
      ...record,
      disabledContributions: [...disabled].sort(),
      updatedAt: nowIso(),
    };
    registry.plugins[pluginId] = next;
    writeRegistry(registry);
    deps.logger.info("plugin.contribution_toggled", { pluginId, socketId: id, enabled });
    emitPluginChange({ kind: "installs", pluginId });
    return describe(next);
  };

  /**
   * Re-copy a `local`-source plugin from the folder it was installed from.
   *
   * `reload` used to restart the child over whatever already sat in the install
   * directory, so editing a local source and reloading served the PREVIOUS
   * bytes — silently, with no error and no changed behaviour, until a second
   * `install` of the same path happened to push the edit. `ade plugin dev`
   * inherited the whole trap, because its watcher calls `reload` too: it
   * watched the source folder and then reloaded a copy nothing had updated.
   *
   * Staged and renamed exactly as `install` does, so a source that has grown
   * past the copy ceilings, lost its manifest, or turned into a DIFFERENT
   * plugin leaves the working install in place rather than half-copied.
   *
   * The directory checksum gate deliberately does not run here. That gate
   * checks bytes which arrived over the NETWORK against what the plugin
   * directory vouches for; these bytes come from a path on this machine that
   * the user approved installing from, and anyone able to write there can
   * already write into the install directory `reload` has always re-run.
   *
   * Returns the warnings to carry on the reloaded plugin: a refused resync must
   * never read as a completed one.
   */
  const resyncLocalSource = (record: PluginInstallRecord): string[] => {
    if (record.source.kind !== "local") return [];
    const source = path.resolve(record.source.path);
    const refused = (reason: string): string[] => {
      deps.logger.warn("plugin.reload_resync_refused", { pluginId: record.pluginId, source, reason });
      return [`Reload kept the installed copy: its source folder ${source} ${reason}.`];
    };
    let target: string;
    try {
      target = pluginRootWithin(root, record.pluginId);
    } catch {
      // A hand-edited registry naming an id that cannot resolve inside the
      // plugins root. Reload still answers about what is installed; only the
      // re-copy is off the table.
      return refused("cannot be resolved to an install directory");
    }
    // Installed FROM the install directory. There is nothing to copy, and the
    // rename below would open a window where neither copy exists.
    if (source === target) return [];
    if (!dirExists(source)) return refused("is gone");

    const stagingDir = path.join(root, `.staging-${randomUUID()}`);
    let staged: PluginManifest;
    try {
      copyPluginTree(source, stagingDir);
      const parsed = readManifestAt(stagingDir);
      if (!parsed.manifest || parsed.errors.length > 0) {
        throw new Error(`has no readable ${PLUGIN_MANIFEST_FILE}: ${parsed.errors[0] ?? "it is missing"}`);
      }
      // A source that renamed itself is a different plugin now. Copying it in
      // under the old id would run code the user installed under another name.
      if (parsed.manifest.name !== record.pluginId) {
        throw new Error(`now declares the id "${parsed.manifest.name}"`);
      }
      if (!isPluginSupportedByAdeVersion(parsed.manifest, deps.adeVersion)) {
        throw new Error(`now requires ADE ${parsed.manifest.minAdeVersion} or newer`);
      }
      staged = parsed.manifest;
    } catch (error) {
      removeQuietly(stagingDir);
      return refused(error instanceof Error ? error.message : String(error));
    }

    const previous = `${target}.previous-${randomUUID()}`;
    const hadPrevious = dirExists(target);
    try {
      if (hadPrevious) fs.renameSync(target, previous);
      fs.renameSync(stagingDir, target);
    } catch (error) {
      // Put the working install back before reporting: a failed resync must not
      // leave the user with no plugin at all.
      if (hadPrevious && !dirExists(target) && dirExists(previous)) {
        try {
          fs.renameSync(previous, target);
        } catch {
          // Nothing further to try; the warning below carries the real cause.
        }
      }
      removeQuietly(stagingDir);
      return refused(`could not be moved into place: ${error instanceof Error ? error.message : String(error)}`);
    }
    removeQuietly(previous);
    deps.logger.info("plugin.reload_resynced", {
      pluginId: record.pluginId,
      source,
      version: staged.version,
    });
    return [];
  };

  const reload = (pluginId: string): PluginInstalledPlugin => {
    const { registry, record } = requireRecord(pluginId);
    // Before the manifest read below, so every answer this function gives
    // describes the tree a restarted child will actually run.
    const resyncWarnings = resyncLocalSource(record);
    const read = describe(record);
    const described = resyncWarnings.length > 0
      ? { ...read, warnings: [...resyncWarnings, ...read.warnings] }
      : read;
    // `ade plugin dev` edits the manifest in place, so the registry's cached
    // version drifts from disk until something re-reads it. This is that read.
    if (described.manifest && described.manifest.version !== record.version) {
      const next: PluginInstallRecord = { ...record, version: described.manifest.version, updatedAt: nowIso() };
      registry.plugins[pluginId] = next;
      writeRegistry(registry);
      emitPluginChange({ kind: "installs", pluginId });
      return { ...described, record: next };
    }
    return described;
  };

  const skillRoots = (): string[] => collectSkillRoots(root, list(), deps.logger);

  const bundledPackageVersion = (pluginId: string): string | null =>
    findBuiltinPackage(pluginId)?.manifest.version ?? null;

  return {
    root,
    list,
    get,
    install,
    uninstall,
    setEnabled,
    setContributionEnabled,
    reload,
    skillRoots,
    bundledPackageVersion,
  };
}

/**
 * Ceilings on plugin-contributed agent skills.
 *
 * A skills root is not just files on disk: every runtime that supports skills
 * reads at least each `SKILL.md`'s front matter into the system prompt of every
 * session, and Claude and Codex are handed the whole root. Panels are capped at
 * 64 KiB and collections at 2 MiB, but skills had no ceiling at all — a plugin
 * could inject unbounded prompt text into every session it touched, and the
 * first symptom would be a context window that filled up for no visible reason.
 *
 * Two numbers rather than one. The per-root file count bounds the WALK, so
 * measuring the budget cannot itself become the slow path on a plugin that
 * shipped a build output tree. The total-byte budget bounds what reaches the
 * runtimes, across every plugin, because the agent pays for the sum.
 */
const PLUGIN_SKILL_ROOTS_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const PLUGIN_SKILL_ROOT_MAX_FILES = 2_000;

/**
 * Bytes in a skills root, or null when it exceeds the file-count ceiling.
 *
 * Stops walking the moment either ceiling is passed: a root that is already too
 * big does not need an exact size, only a verdict. Symlinks are not followed —
 * `readdirSync` reports a link as neither file nor directory here, so a link out
 * of the plugin directory contributes nothing and cannot make the walk escape.
 */
function measureSkillRootBytes(root: string, budgetBytes: number): number | null {
  let bytes = 0;
  let files = 0;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      if (files > PLUGIN_SKILL_ROOT_MAX_FILES) return null;
      try {
        bytes += fs.statSync(child).size;
      } catch {
        continue;
      }
      if (bytes > budgetBytes) return bytes;
    }
  }
  return bytes;
}

/**
 * The skill roots to hand agent runtimes, in registry order, within budget.
 *
 * Truncation is LOGGED, never silent: a dropped root means a skill the plugin
 * author shipped and the agent will not see, and a plugin that appears installed
 * and enabled while one of its skills is invisible is exactly the kind of gap
 * that gets debugged as "the model ignored my instructions".
 */
function collectSkillRoots(
  root: string,
  installed: readonly PluginInstalledPlugin[],
  logger: Pick<Logger, "warn"> | null = null,
): string[] {
  const roots: string[] = [];
  let totalBytes = 0;
  for (const plugin of installed) {
    if (!plugin.record.enabled || !plugin.manifest) continue;
    for (const relative of plugin.manifest.skills) {
      const resolved = path.resolve(plugin.root, relative);
      // The manifest parser already refuses traversal, but a skills root is
      // handed to agent runtimes verbatim, so it is re-checked against both the
      // plugin directory and the plugins root before it can escape.
      if (!isPathInside(resolved, plugin.root)) continue;
      if (!isPathInside(resolved, root)) continue;
      if (!dirExists(resolved)) continue;
      const remaining = PLUGIN_SKILL_ROOTS_MAX_TOTAL_BYTES - totalBytes;
      const bytes = measureSkillRootBytes(resolved, remaining);
      if (bytes === null || bytes > remaining) {
        logger?.warn("plugin.skill_root_dropped", {
          pluginId: plugin.record.pluginId,
          root: resolved,
          reason: bytes === null ? "file_count" : "total_bytes",
          ...(bytes === null ? { maxFiles: PLUGIN_SKILL_ROOT_MAX_FILES } : { bytes, remainingBytes: remaining }),
          totalBudgetBytes: PLUGIN_SKILL_ROOTS_MAX_TOTAL_BYTES,
        });
        continue;
      }
      totalBytes += bytes;
      roots.push(resolved);
    }
  }
  return roots;
}

/**
 * Daemon-free skill-root discovery for callers that cannot hold the install
 * service (the CLI, and the env-building path that runs before the runtime
 * exists). Reads the same registry, never the directory listing.
 */
export function listPluginAgentSkillRoots(
  options: { pluginsRoot?: string; env?: NodeJS.ProcessEnv; logger?: Pick<Logger, "warn"> } = {},
): string[] {
  const root = options.pluginsRoot?.trim() || resolvePluginsRoot(options.env ?? process.env);
  return collectSkillRoots(root, readInstalledPluginsFromRegistry(root), options.logger ?? null);
}

/**
 * Every registry-listed plugin with its manifest, without constructing the
 * install service.
 *
 * Shared by the two daemon-free readers below. Reads the registry, never the
 * directory listing: a directory nobody registered is not installed, and a
 * registry entry whose manifest will not parse must still appear (as a plugin
 * with a null manifest) so callers can tell "absent" from "broken".
 */
export function readInstalledPluginsFromRegistry(pluginsRoot: string): PluginInstalledPlugin[] {
  const registry = readPluginRegistryContents(pluginsRoot);
  return Object.values(registry.plugins).map((record): PluginInstalledPlugin => {
    const pluginRoot = path.join(pluginsRoot, record.pluginId);
    const parsed = readManifestAt(pluginRoot);
    return { record, manifest: parsed.manifest, root: pluginRoot, errors: parsed.errors, warnings: parsed.warnings };
  });
}
