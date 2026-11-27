import { pathIsWithinRoot, samePathOnPlatform } from "./pathContainment";

export const ADE_AGENT_SKILLS_DIRS_ENV = "ADE_AGENT_SKILLS_DIRS";
export const ADE_BUNDLED_AGENT_SKILLS_DIR_ENV = "ADE_BUNDLED_AGENT_SKILLS_DIR";

export type AgentSkillRootSource = "project" | "user" | "bundled";

export type AgentSkillRootWithSource = {
  root: string;
  source: AgentSkillRootSource;
};

function processRef(): NodeJS.Process | null {
  return typeof process !== "undefined" ? process : null;
}

function pathDelimiter(): string {
  return processRef()?.platform === "win32" ? ";" : ":";
}

function normalizePathEntry(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed.replace(/[\\/]+$/, "");
}

function joinPath(root: string, ...parts: string[]): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ""))].join(sep);
}

function parentPath(value: string): string | null {
  const normalized = value.replace(/[\\/]+$/, "");
  const parent = normalized.replace(/[\\/][^\\/]+$/, "");
  return parent && parent !== normalized ? parent : null;
}

function addPath(target: string[], seen: Set<string>, value: string | null | undefined): void {
  const normalized = normalizePathEntry(value);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push(normalized);
}

function homePath(env: NodeJS.ProcessEnv): string | null {
  const home = normalizePathEntry(env.HOME ?? env.USERPROFILE);
  if (home) return home;
  const drive = normalizePathEntry(env.HOMEDRIVE);
  const pathPart = String(env.HOMEPATH ?? "").trim();
  return drive && pathPart ? normalizePathEntry(`${drive}${pathPart}`) : null;
}

const ancestorSkillDirs = [".cursor", ".claude", ".agents", ".ade", ".codex"] as const;
const promptAgentSkillRootLimit = 4;
type AncestorSkillDir = (typeof ancestorSkillDirs)[number];

function addAncestorSkillRoots(
  roots: string[],
  seen: Set<string>,
  cwd: string | null | undefined,
  dirName: AncestorSkillDir,
  home: string | null,
): void {
  let current = normalizePathEntry(cwd);
  if (!current) return;
  for (let depth = 0; depth < 25; depth += 1) {
    addPath(roots, seen, joinPath(current, dirName, "skills"));
    if (home && current.toLowerCase() === home.toLowerCase()) break;
    const parent = parentPath(current);
    if (!parent) break;
    current = parent;
  }
}

export function splitAdeAgentSkillRoots(value: string | null | undefined): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const entry of String(value ?? "").split(pathDelimiter())) {
    addPath(roots, seen, entry);
  }
  return roots;
}

export function joinAdeAgentSkillRoots(roots: readonly string[]): string {
  const normalizedRoots: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) addPath(normalizedRoots, seen, root);
  return normalizedRoots.join(pathDelimiter());
}

/**
 * The Claude plugin the bundled skills ship as (`.claude-plugin/plugin.json`
 * `name`), so Claude names them `daex:<skill>`. Builds before the Daex rename
 * shipped the plugin as `ade`, so saved prompts and transcripts say
 * `ade:ade-<skill>`; {@link canonicalBundledAgentSkillName} maps those.
 */
export const BUNDLED_AGENT_SKILL_PLUGIN = "daex";
export const LEGACY_BUNDLED_AGENT_SKILL_PLUGIN = "ade";

/**
 * Every bundled skill folder under `apps/desktop/resources/agent-skills`, by
 * its Daex name. `adeBundledAgentSkills` (prompt order) and the packaging
 * roster mirror this set; bundledAgentSkills.test.ts binds them to the disk.
 */
export const BUNDLED_AGENT_SKILL_NAMES = [
  "daex-android",
  "daex-app-control",
  "daex-apple",
  "daex-browser",
  "daex-cli-control-plane",
  "daex-cloud",
  "daex-computer-use",
  "daex-deeplinks",
  "daex-harnesses",
  "daex-lanes-git",
  "daex-linear",
  "daex-mcp-client",
  "daex-pr-workflows",
  "daex-proof-artifacts",
  "daex-scene",
  "daex-search",
  "daex-webhooks",
] as const;

export type BundledAgentSkillName = (typeof BUNDLED_AGENT_SKILL_NAMES)[number];

const bundledAgentSkillNameSet: ReadonlySet<string> = new Set(BUNDLED_AGENT_SKILL_NAMES);

/**
 * Old bundled skill name → the Daex skill that answers it now. Every skill was
 * `ade-<x>` before the rename (now `daex-<x>`); two names were already retired
 * aliases with no folder of their own. These names are never listed to an
 * agent; ADE accepts them wherever it resolves a skill by name (`ade skill
 * show`, ADE MCP prompts, withheld-skill checks, the `/` menu filters).
 */
export const LEGACY_BUNDLED_AGENT_SKILL_ALIASES: Readonly<Record<string, BundledAgentSkillName>> = Object.freeze({
  ...Object.fromEntries(
    BUNDLED_AGENT_SKILL_NAMES.map((name) => [`ade-${name.slice("daex-".length)}`, name]),
  ),
  "ade-desktop": "daex-computer-use",
  "ade-ios-simulator": "daex-apple",
});

/** The old names of {@link LEGACY_BUNDLED_AGENT_SKILL_ALIASES}, for filters that hide them from listings. */
export const LEGACY_BUNDLED_AGENT_SKILL_NAMES: ReadonlySet<string> = new Set(Object.keys(LEGACY_BUNDLED_AGENT_SKILL_ALIASES));

/**
 * A skill name as someone may type it (`ade-browser`, `/ade:ade-browser`,
 * `daex:daex-browser`, `$daex-browser`), as the bundled Daex name when it
 * names a bundled skill, else the bare name unchanged (lowercased, without a
 * leading `/` or `$`). Callers that look a skill up by name try the exact
 * name first, so a project skill that happens to carry an old name still wins.
 */
export function canonicalBundledAgentSkillName(name: string): string {
  let bare = String(name ?? "").trim().replace(/^[/$]+/, "").trim().toLowerCase();
  const separator = bare.indexOf(":");
  if (separator > 0) {
    const plugin = bare.slice(0, separator);
    if (plugin === BUNDLED_AGENT_SKILL_PLUGIN || plugin === LEGACY_BUNDLED_AGENT_SKILL_PLUGIN) {
      bare = bare.slice(separator + 1);
    }
  }
  if (bundledAgentSkillNameSet.has(bare)) return bare;
  return LEGACY_BUNDLED_AGENT_SKILL_ALIASES[bare] ?? bare;
}

/** True when `name` (any spelling {@link canonicalBundledAgentSkillName} takes) is one of these skills. */
export function isAgentSkillNamed(name: string, skills: readonly string[]): boolean {
  const canonical = canonicalBundledAgentSkillName(name);
  return skills.some((skill) => canonicalBundledAgentSkillName(skill) === canonical);
}

/**
 * A message that opens with an old bundled-skill command, sent under the
 * Daex name: `/ade:ade-browser go` → `/daex:daex-browser go` (Claude's plugin
 * form) and `/ade-browser go` → `/daex-browser go` (the bare form Codex,
 * Copilot and the `/` menus use). Saved prompts, automations and muscle memory
 * still type the old names, and no provider knows them any more. Any other
 * text, including an old-looking name that is not a bundled skill, is
 * returned unchanged, and so is a bare `/ade-<x>` when `ownSkillExists` says
 * a project or user skill carries that exact name: it wins, as in
 * {@link canonicalBundledAgentSkillName}.
 */
export function rewriteLegacyBundledSkillCommand(text: string, ownSkillExists?: (name: string) => boolean): string {
  const match = /^(\s*)\/(ade:)?(ade-[a-z0-9-]+)(?=\s|$)/.exec(text);
  if (!match) return text;
  const target = LEGACY_BUNDLED_AGENT_SKILL_ALIASES[match[3]!];
  if (!target) return text;
  if (!match[2] && ownSkillExists?.(match[3]!)) return text;
  const command = match[2] ? `/${BUNDLED_AGENT_SKILL_PLUGIN}:${target}` : `/${target}`;
  return `${match[1]}${command}${text.slice(match[0].length)}`;
}

/**
 * A withheld list with each bundled skill under both its Daex and its old
 * name, so a root that still carries an old folder (an older brain's
 * `agent-skills` on another machine, an `ADE_AGENT_SKILLS_DIRS` from an older
 * build) is filtered the same, and callers that still check an old name
 * (`includes("ade-cloud")`) keep their answer.
 */
export function withLegacyAgentSkillNames(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    out.add(name);
    const canonical = canonicalBundledAgentSkillName(name);
    if (!bundledAgentSkillNameSet.has(canonical)) continue;
    out.add(canonical);
    for (const [legacy, target] of Object.entries(LEGACY_BUNDLED_AGENT_SKILL_ALIASES)) {
      // A retired alias (`ade-ios-simulator` -> `daex-apple`) follows its target.
      if (target === canonical) out.add(legacy);
    }
  }
  return [...out];
}

/** Every process's default for bundled skills held back from agents, until a brain knows better. */
const ALWAYS_WITHHELD_AGENT_SKILLS: readonly string[] = [
  // ADE Cloud's old skill name: a remote machine's older agent-skills folder can still carry it.
  "ade-agent37",
];

/**
 * Skills whose `daex` commands run only on a Mac: `daex apple` drives Xcode's
 * simulators and answers `supported: false` on any other host. Every other
 * bundled skill works on macOS, Windows and Linux (Android needs a machine
 * with virtualization, which a Linux VM or a full cloud computer has).
 */
const MAC_ONLY_AGENT_SKILLS: readonly string[] = withLegacyAgentSkillNames(["daex-apple"]);

/** The Daex Cloud skill, under both names: held back until the account is on the access list. */
const CLOUD_AGENT_SKILL_NAMES: readonly string[] = withLegacyAgentSkillNames(["daex-cloud"]);

/**
 * The bundled skills this host cannot use. The host is the process that builds
 * the agent's skills: the brain that runs the chat, on the lane's own machine.
 * The renderer bundles this file and has no `process`, so it withholds nothing.
 */
export function adeHostWithheldAgentSkills(
  platform: string | null = typeof process !== "undefined" && typeof process.platform === "string" ? process.platform : null,
): readonly string[] {
  return platform && platform !== "darwin" ? MAC_ONLY_AGENT_SKILLS : [];
}

let adeCloudSkillVisible = false;
/** The account has the ADE Cloud iPhone: `daex-apple` is for any host then, not only a Mac. */
let adeCloudIphoneVisible = false;
let agentSkillAccessRefresh: (() => void) | null = null;
let agentSkillRootFilter: ((roots: readonly string[]) => string[]) | null = null;

/**
 * Bundled skills no agent may see right now: `daex-cloud` unless this account
 * is on ADE Cloud's access list, and the skills this host cannot run
 * ({@link adeHostWithheldAgentSkills}), except `daex-apple` for an account
 * with the ADE Cloud iPhone, which any host drives. Every skill channel (prompt listing,
 * the skill roots, the `daex-*` line of guidance, `ade skill`) reads this one set.
 * Each skill is named both ways ({@link withLegacyAgentSkillNames}).
 */
export function adeWithheldAgentSkills(): readonly string[] {
  return [
    ...adeAccessWithheldAgentSkills(),
    ...adeHostWithheldAgentSkills().filter((name) => !(adeCloudIphoneVisible && canonicalBundledAgentSkillName(name) === "daex-apple")),
  ];
}

/**
 * The skills an agent may not read even when it asks for one by name
 * (`ade skill show`): the access rules only. A skill this host merely can't
 * run here (`daex-apple` on Windows) still reads by name, because a chat
 * here drives a Mac's simulator (`--machine`) or the ADE Cloud iPhone with it.
 */
export function adeAccessWithheldAgentSkills(): readonly string[] {
  agentSkillAccessRefresh?.();
  return [...ALWAYS_WITHHELD_AGENT_SKILLS, ...(adeCloudSkillVisible ? [] : CLOUD_AGENT_SKILL_NAMES)];
}

/** Whether the account has the ADE Cloud iPhone (`access: "on"`), from whoever just asked the server. */
export function setAdeCloudIphoneSkillVisible(visible: boolean): void {
  adeCloudIphoneVisible = visible;
}

/** The account's ADE Cloud answer, from whoever just asked the server. */
export function setAdeCloudSkillVisible(visible: boolean): void {
  adeCloudSkillVisible = visible;
}

/** Called each time an agent's skills are worked out, so a stale answer asks the server again. */
export function setAgentSkillAccessRefresh(refresh: (() => void) | null): void {
  agentSkillAccessRefresh = refresh;
}

/** Node installs the filter that actually mirrors roots; the renderer bundles this file and has no disk. */
export function setAgentSkillRootFilter(filter: ((roots: readonly string[]) => string[]) | null): void {
  agentSkillRootFilter = filter;
}

/** Roots with the withheld skills removed, or as given when no filter is installed (the renderer). */
export function filterAdeAgentSkillRoots(roots: readonly string[]): string[] {
  return agentSkillRootFilter ? agentSkillRootFilter(roots) : [...roots];
}

/**
 * Adds the two repo-relative bundled-skill shapes for one base directory.
 *
 * Two guards keep this from minting roots that cannot exist. A packaged app
 * runs with `process.cwd() === "/"`, which used to yield the absolute
 * `/apps/desktop/resources/agent-skills` and `/resources/agent-skills`; a dev
 * run started from `apps/desktop` used to yield a doubled
 * `<repo>/apps/desktop/apps/desktop/resources/agent-skills`. Both shipped in
 * agent prompts and in `ADE_AGENT_SKILLS_DIRS`, and because the prompt list is
 * capped they pushed the real root out of the list.
 */
function addBundledSkillRootsForBase(roots: string[], seen: Set<string>, base: string | null | undefined): void {
  // `normalizePathEntry` strips trailing separators, so a POSIX root ("/")
  // normalizes to the empty string. A bare Windows drive ("C:\") normalizes to
  // "C:". Neither belongs to a checkout or an install, so joining onto them
  // only produces paths that cannot exist.
  const normalized = normalizePathEntry(base);
  if (!normalized || /^[a-z]:$/i.test(normalized)) return;
  // Prefer the active lane worktree before inherited app roots.
  if (!/[\\/]apps[\\/]desktop$/i.test(normalized)) {
    addPath(roots, seen, joinPath(normalized, "apps", "desktop", "resources", "agent-skills"));
  }
  addPath(roots, seen, joinPath(normalized, "resources", "agent-skills"));
}

export function getAdeAgentSkillRootCandidates(options: {
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string | null;
  cwd?: string | null;
  processCwd?: string | null;
  dirname?: string | null;
  includeDeepSourceFallbacks?: boolean;
} = {}): string[] {
  const proc = processRef();
  const env = options.env ?? proc?.env ?? {};
  const roots: string[] = [];
  const seen = new Set<string>();

  const liveCwd = typeof proc?.cwd === "function" ? proc.cwd() : null;
  const cwd = options.cwd ?? liveCwd;
  const processCwd = options.processCwd === undefined ? liveCwd : options.processCwd;
  for (const rootCwd of [cwd, processCwd]) {
    addBundledSkillRootsForBase(roots, seen, rootCwd);
  }

  for (const root of splitAdeAgentSkillRoots(env[ADE_AGENT_SKILLS_DIRS_ENV])) addPath(roots, seen, root);

  const resourcesPath = options.resourcesPath ?? (proc as (NodeJS.Process & { resourcesPath?: string }) | null)?.resourcesPath ?? null;
  if (resourcesPath) addPath(roots, seen, joinPath(resourcesPath, "agent-skills"));

  const dirname = options.dirname ?? (typeof __dirname !== "undefined" ? __dirname : null);
  if (dirname && options.includeDeepSourceFallbacks) {
    let current = dirname;
    for (let depth = 0; depth < 8; depth += 1) {
      addPath(roots, seen, joinPath(current, "resources", "agent-skills"));
      addPath(roots, seen, joinPath(current, "apps", "desktop", "resources", "agent-skills"));
      const next = current.replace(/[\\/][^\\/]+$/, "");
      if (!next || next === current) break;
      current = next;
    }
  }

  return roots;
}

export function getAgentSkillRootCandidates(options: {
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string | null;
  cwd?: string | null;
  dirname?: string | null;
  home?: string | null;
  includeDeepSourceFallbacks?: boolean;
} = {}): string[] {
  const proc = processRef();
  const env = options.env ?? proc?.env ?? {};
  const roots: string[] = [];
  const seen = new Set<string>();
  const cwd = options.cwd ?? (typeof proc?.cwd === "function" ? proc.cwd() : null);

  const home = normalizePathEntry(options.home) ?? homePath(env);
  for (const dirName of ancestorSkillDirs) {
    addAncestorSkillRoots(roots, seen, cwd, dirName, home);
  }

  if (home) {
    for (const dirName of ancestorSkillDirs) {
      addPath(roots, seen, joinPath(home, dirName, "skills"));
    }
  }

  for (const root of getAdeAgentSkillRootCandidates(options)) addPath(roots, seen, root);

  return roots;
}

/**
 * Separates roots by who owns them, keeping project roots nearest-first.
 * Bundled candidates under the active project are project skills in practice.
 */
export function getAgentSkillRootsWithSource(options: {
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string | null;
  cwd?: string | null;
  processCwd?: string | null;
  dirname?: string | null;
  home?: string | null;
  includeDeepSourceFallbacks?: boolean;
} = {}): AgentSkillRootWithSource[] {
  const proc = processRef();
  const env = options.env ?? proc?.env ?? {};
  const cwd = normalizePathEntry(options.cwd ?? (typeof proc?.cwd === "function" ? proc.cwd() : null));
  const home = normalizePathEntry(options.home) ?? homePath(env);

  const projectRoots: string[] = [];
  const projectSeen = new Set<string>();
  let current = cwd;
  for (let depth = 0; current && depth < 25; depth += 1) {
    if (home && samePathOnPlatform(current, home, proc?.platform)) break;
    for (const dirName of ancestorSkillDirs) {
      addPath(projectRoots, projectSeen, joinPath(current, dirName, "skills"));
    }
    current = parentPath(current);
  }

  const userRoots: string[] = [];
  const userSeen = new Set<string>();
  if (home) {
    for (const dirName of ancestorSkillDirs) {
      addPath(userRoots, userSeen, joinPath(home, dirName, "skills"));
    }
  }

  const bundledCandidates = getAdeAgentSkillRootCandidates(options);
  const projectBundledRoots: string[] = [];
  const projectBundledSeen = new Set<string>();
  const bundledRoots: string[] = [];
  const bundledSeen = new Set<string>();
  for (const root of bundledCandidates) {
    if (cwd && pathIsWithinRoot(cwd, root, proc?.platform)) {
      addPath(projectBundledRoots, projectBundledSeen, root);
    } else {
      addPath(bundledRoots, bundledSeen, root);
    }
  }

  const result: AgentSkillRootWithSource[] = [];
  const seen = new Set<string>();
  for (const root of projectRoots) addRootWithSource(result, seen, root, "project");
  for (const root of projectBundledRoots) addRootWithSource(result, seen, root, "project");
  for (const root of userRoots) addRootWithSource(result, seen, root, "user");
  for (const root of bundledRoots) addRootWithSource(result, seen, root, "bundled");
  return result;
}

function addRootWithSource(
  target: AgentSkillRootWithSource[],
  seen: Set<string>,
  root: string,
  source: AgentSkillRootSource,
): void {
  const normalized = normalizePathEntry(root);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push({ root: normalized, source });
}

/**
 * The prompt- and env-facing slice of the bundled skill roots.
 *
 * `exists` is optional because this module is also bundled into the renderer,
 * which has no filesystem. Every Node caller must pass one: the list is capped,
 * so without the filter a root that does not exist on disk takes a slot from a
 * root that does, and the agent is told to read a path it cannot open. The
 * filter runs before the cap for exactly that reason.
 */
export function getAdeAgentSkillRootsForPrompt(options: {
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string | null;
  cwd?: string | null;
  processCwd?: string | null;
  dirname?: string | null;
  includeDeepSourceFallbacks?: boolean;
  exists?: (candidate: string) => boolean;
  /** The env builder: the variable keeps every root, and each launch filters what it passes on. */
  includeWithheld?: boolean;
} = {}): string[] {
  const candidates = getAdeAgentSkillRootCandidates(options);
  const usable = options.exists ? candidates.filter((root) => options.exists?.(root)) : candidates;
  const roots = usable.slice(0, promptAgentSkillRootLimit);
  return options.includeWithheld ? roots : filterAdeAgentSkillRoots(roots);
}

export function formatAdeAgentSkillRootsForPrompt(roots: readonly string[]): string {
  const normalized = roots
    .map((root) => normalizePathEntry(root))
    .filter((root): root is string => Boolean(root));
  if (!normalized.length) {
    return "The exact agent skill roots are exposed as `ADE_AGENT_SKILLS_DIRS` when Daex launches this CLI; inspect that env var if your runtime does not auto-list skills.";
  }
  return `Agent skill root${normalized.length === 1 ? "" : "s"} for this session: ${normalized.join(", ")}. Read \`<root>/<skill-name>/SKILL.md\` on demand when a named skill is relevant.`;
}
