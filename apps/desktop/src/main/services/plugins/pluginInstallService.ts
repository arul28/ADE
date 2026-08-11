import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { Logger } from "../logging/logger";
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
import type { PluginInstallRecord, PluginInstallSource } from "../../../shared/plugins/sdk";
import { emitPluginChange } from "./pluginEvents";

const PLUGIN_STATE_FILE = "state.json";
const PLUGIN_MANIFEST_FILE = "plugin.json";

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
  /** Re-read the manifest from disk (the `ade plugin dev` loop). */
  reload(pluginId: string): PluginInstalledPlugin;
  /** Absolute skill directories that exist, enabled plugins only. */
  skillRoots(): string[];
};

type PluginRegistryFile = {
  version: 1;
  plugins: Record<string, PluginInstallRecord>;
  /**
   * Builtin plugins the user removed on purpose.
   *
   * Seeding is idempotent by checking "is there a record", so without a
   * tombstone an uninstalled builtin would reappear on the next read — the user
   * would delete it, and ADE would put it straight back. The id stays here
   * forever; that is the point.
   */
  removedBuiltins: string[];
};

/** `<machine adeDir>/plugins` — installs are machine-scoped, never per project. */
export function resolvePluginsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMachineAdeLayout(env).adeDir, "plugins");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseInstallSource(raw: unknown): PluginInstallSource {
  if (isRecord(raw)) {
    if (raw.kind === "local" && typeof raw.path === "string") return { kind: "local", path: raw.path };
    if (raw.kind === "git" && typeof raw.url === "string") {
      return { kind: "git", url: raw.url, ...(typeof raw.ref === "string" ? { ref: raw.ref } : {}) };
    }
  }
  return { kind: "builtin" };
}

function parseInstallRecord(pluginId: string, raw: unknown): PluginInstallRecord | null {
  if (!isRecord(raw)) return null;
  const version = typeof raw.version === "string" ? raw.version : "0.0.0";
  const installedAt = typeof raw.installedAt === "string" ? raw.installedAt : nowIso();
  const disabled = Array.isArray(raw.disabledContributions)
    ? [...new Set(raw.disabledContributions.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  return {
    pluginId,
    version,
    enabled: raw.enabled !== false,
    source: parseInstallSource(raw.source),
    installedAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : installedAt,
    // Always present after a read, so nothing downstream has to distinguish
    // "no field" from "nothing disabled" — they mean the same thing.
    disabledContributions: disabled,
  };
}

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
      "git",
      ["-C", stagingDir, "archive", "--format=tar", "-o", tarPath, "HEAD"],
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

function readRegistryFile(statePath: string): PluginRegistryFile {
  let text: string;
  try {
    text = fs.readFileSync(statePath, "utf8");
  } catch {
    return { version: 1, plugins: {}, removedBuiltins: [] };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { version: 1, plugins: {}, removedBuiltins: [] };
  }
  if (!isRecord(decoded) || !isRecord(decoded.plugins)) return { version: 1, plugins: {}, removedBuiltins: [] };
  const plugins: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, raw] of Object.entries(decoded.plugins)) {
    // The registry is the source of truth for what is installed, so a key that
    // could not be a directory name is dropped here rather than defended
    // against at every path join downstream.
    if (!isValidPluginId(pluginId)) continue;
    const record = parseInstallRecord(pluginId, raw);
    if (record) plugins[pluginId] = record;
  }
  const removedBuiltins = Array.isArray(decoded.removedBuiltins)
    ? [...new Set(decoded.removedBuiltins.filter(isValidPluginId))]
    : [];
  return { version: 1, plugins, removedBuiltins };
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
 * `plugins/`. The candidate walk mirrors `getAdeAgentSkillRootCandidates` — the
 * same problem, solved the same way, so a dev checkout and a shipped app find
 * their resources by the same rules.
 */
export function resolveBuiltinPluginsRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.ADE_BUILTIN_PLUGINS_DIR?.trim();
  if (configured) return dirExists(configured) ? configured : null;
  // Under test the walk would find the repo's own `plugins/` and seed real
  // packages into whatever temp install root a test just created — every test
  // that builds an install service would silently gain two plugins it never
  // installed. Tests opt in by passing `builtinPluginsRoot` explicitly.
  if (env.VITEST || env.VITEST_WORKER_ID || env.NODE_ENV === "test") return null;
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, "plugins"));
  const starts = [process.cwd(), typeof __dirname === "string" ? __dirname : null];
  for (const start of starts) {
    if (!start) continue;
    let current = start;
    for (let depth = 0; depth < 8; depth += 1) {
      candidates.push(path.join(current, "plugins"));
      candidates.push(path.join(current, "apps", "desktop", "resources", "plugins"));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const candidate of candidates) {
    if (dirExists(candidate)) return candidate;
  }
  return null;
}

/** Bundled package directories that carry a readable, valid manifest. */
function listBuiltinPackages(builtinRoot: string): { pluginId: string; source: string; manifest: PluginManifest }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(builtinRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const packages: { pluginId: string; source: string; manifest: PluginManifest }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidPluginId(entry.name)) continue;
    const source = path.join(builtinRoot, entry.name);
    const parsed = readManifestAt(source);
    // A bundled package that does not parse is a build problem, not a user
    // problem; seeding it would surface as a broken plugin nobody installed.
    if (!parsed.manifest || parsed.errors.length > 0) continue;
    if (parsed.manifest.name !== entry.name) continue;
    packages.push({ pluginId: entry.name, source, manifest: parsed.manifest });
  }
  return packages;
}

export function createPluginInstallService(deps: {
  logger: Logger;
  pluginsRoot?: string;
  adeVersion?: string | null;
  /**
   * The directory's entry for a plugin, when the directory is reachable.
   * Injected rather than imported so this service never fetches anything
   * itself; a null answer (offline, or an unlisted plugin) installs unverified.
   */
  resolveRegistryEntry?: (
    pluginId: string,
  ) => Promise<Pick<PluginRegistryEntry, "official" | "checksums"> | null>;
  /**
   * Tell the directory an install happened. Fire-and-forget by contract: the
   * install has already succeeded by the time this runs, and telemetry that can
   * fail an install is worse than telemetry that is occasionally missing.
   */
  reportInstall?: (install: { pluginId: string; version: string }) => void | Promise<void>;
  /** Bundled plugin packages to seed. Defaults to {@link resolveBuiltinPluginsRoot}. */
  builtinPluginsRoot?: string | null;
}): PluginInstallService {
  const root = deps.pluginsRoot?.trim() || resolvePluginsRoot();
  const statePath = path.join(root, PLUGIN_STATE_FILE);
  const builtinRoot = deps.builtinPluginsRoot === undefined
    ? resolveBuiltinPluginsRoot()
    : deps.builtinPluginsRoot;
  let builtinsSeeded = false;

  /**
   * Copy each bundled package that this machine has not seen into the install
   * root, once. Copying rather than referencing the bundle keeps every other
   * invariant intact — `describe`, `skillRoots` and `uninstall` all assume a
   * plugin lives at `<root>/<id>`, and the skills-root guard actively refuses a
   * path outside it — and it means an app update ships a new version by simply
   * bumping the manifest, which the version check below picks up.
   */
  const seedBuiltins = (registry: PluginRegistryFile): boolean => {
    if (!builtinRoot) return false;
    let changed = false;
    for (const bundled of listBuiltinPackages(builtinRoot)) {
      if (registry.removedBuiltins.includes(bundled.pluginId)) continue;
      const existing = registry.plugins[bundled.pluginId];
      // A user-installed plugin of the same id wins: they chose that copy, and
      // silently replacing it with ours would discard their install.
      if (existing && existing.source.kind !== "builtin") continue;
      if (existing && existing.version === bundled.manifest.version) continue;
      const target = pluginRootWithin(root, bundled.pluginId);
      try {
        if (dirExists(target)) fs.rmSync(target, { recursive: true, force: true });
        copyPluginTree(bundled.source, target);
      } catch (error) {
        deps.logger.warn("plugin.builtin_seed_failed", {
          pluginId: bundled.pluginId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const now = nowIso();
      registry.plugins[bundled.pluginId] = {
        pluginId: bundled.pluginId,
        version: bundled.manifest.version,
        // Enablement survives an update: a user who disabled a builtin keeps it
        // disabled when the next release ships a newer copy.
        enabled: existing?.enabled ?? true,
        source: { kind: "builtin" },
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      };
      changed = true;
      deps.logger.info("plugin.builtin_seeded", {
        pluginId: bundled.pluginId,
        version: bundled.manifest.version,
        replaced: Boolean(existing),
      });
    }
    return changed;
  };

  const readRegistry = (): PluginRegistryFile => {
    const registry = readRegistryFile(statePath);
    // Seeding lives in the read path so a bundled plugin is present the first
    // time anything asks, without a caller having to remember to seed. The flag
    // keeps it to once per service: the copy is filesystem work, not something
    // every `list()` should redo.
    if (builtinsSeeded) return registry;
    builtinsSeeded = true;
    if (seedBuiltins(registry)) {
      try {
        writeRegistry(registry);
      } catch {
        // The seeded records are already in the returned registry, so this read
        // is correct either way; the next read retries the write.
        builtinsSeeded = false;
      }
    }
    return registry;
  };

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

  const get = (pluginId: string): PluginInstalledPlugin | null => {
    const record = readRegistry().plugins[pluginId];
    return record ? describe(record) : null;
  };

  const requireRecord = (pluginId: string): { registry: PluginRegistryFile; record: PluginInstallRecord } => {
    const registry = readRegistry();
    const record = registry.plugins[pluginId];
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
      "git",
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
   * moved into place and never runs. The three-way verdict is Wave E's: only a
   * MISMATCH is fatal. "Unverified" covers every community plugin and any
   * official release the crawler has not indexed yet, and failing those would
   * make the directory a gate on installing anything at all.
   */
  const verifyStagedTree = async (stagingDir: string, manifest: PluginManifest): Promise<void> => {
    if (!deps.resolveRegistryEntry) return;
    let entry: Pick<PluginRegistryEntry, "official" | "checksums"> | null = null;
    try {
      entry = await deps.resolveRegistryEntry(manifest.name);
    } catch {
      // An unreachable directory installs unverified rather than not at all.
      return;
    }
    if (!entry || !requiresChecksumVerification(entry, manifest.version)) return;
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
    const stagingDir = path.join(root, `.staging-${randomUUID()}`);
    let manifest: PluginManifest;
    let warnings: string[];
    try {
      if (isLocalDirectory) {
        stageFromLocalDirectory(path.resolve(source), stagingDir);
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
      await verifyStagedTree(stagingDir, parsed.manifest);
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
      source: isLocalDirectory
        ? { kind: "local", path: path.resolve(source) }
        : { kind: "git", url: source, ...(args.ref ? { ref: args.ref } : {}) },
      installedAt: existing?.installedAt ?? at,
      updatedAt: at,
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
    const known = Boolean(registry.plugins[pluginId]);
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
      // Removing a builtin has to be remembered, or the next read seeds it
      // straight back and the uninstall looks like it silently failed.
      if (registry.plugins[pluginId]?.source.kind === "builtin"
        && !registry.removedBuiltins.includes(pluginId)) {
        registry.removedBuiltins.push(pluginId);
      }
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

  const reload = (pluginId: string): PluginInstalledPlugin => {
    const { registry, record } = requireRecord(pluginId);
    const described = describe(record);
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

  const skillRoots = (): string[] => collectSkillRoots(root, list());

  return { root, list, get, install, uninstall, setEnabled, setContributionEnabled, reload, skillRoots };
}

function collectSkillRoots(root: string, installed: readonly PluginInstalledPlugin[]): string[] {
  const roots: string[] = [];
  for (const plugin of installed) {
    if (!plugin.record.enabled || !plugin.manifest) continue;
    for (const relative of plugin.manifest.skills) {
      const resolved = path.resolve(plugin.root, relative);
      // The manifest parser already refuses traversal, but a skills root is
      // handed to agent runtimes verbatim, so it is re-checked against both the
      // plugin directory and the plugins root before it can escape.
      if (!resolved.startsWith(`${plugin.root}${path.sep}`) && resolved !== plugin.root) continue;
      if (!resolved.startsWith(`${root}${path.sep}`)) continue;
      if (dirExists(resolved)) roots.push(resolved);
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
  options: { pluginsRoot?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const root = options.pluginsRoot?.trim() || resolvePluginsRoot(options.env ?? process.env);
  const registry = readRegistryFile(path.join(root, PLUGIN_STATE_FILE));
  const installed = Object.values(registry.plugins).map((record): PluginInstalledPlugin => {
    const pluginRoot = path.join(root, record.pluginId);
    const parsed = readManifestAt(pluginRoot);
    return { record, manifest: parsed.manifest, root: pluginRoot, errors: parsed.errors, warnings: parsed.warnings };
  });
  return collectSkillRoots(root, installed);
}
