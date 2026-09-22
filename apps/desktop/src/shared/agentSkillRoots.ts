export const ADE_AGENT_SKILLS_DIRS_ENV = "ADE_AGENT_SKILLS_DIRS";
export const ADE_BUNDLED_AGENT_SKILLS_DIR_ENV = "ADE_BUNDLED_AGENT_SKILLS_DIR";

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
} = {}): string[] {
  const candidates = getAdeAgentSkillRootCandidates(options);
  const usable = options.exists ? candidates.filter((root) => options.exists?.(root)) : candidates;
  return usable.slice(0, promptAgentSkillRootLimit);
}

export function formatAdeAgentSkillRootsForPrompt(roots: readonly string[]): string {
  const normalized = roots
    .map((root) => normalizePathEntry(root))
    .filter((root): root is string => Boolean(root));
  if (!normalized.length) {
    return "The exact agent skill roots are exposed as `ADE_AGENT_SKILLS_DIRS` when ADE launches this CLI; inspect that env var if your runtime does not auto-list skills.";
  }
  return `Agent skill root${normalized.length === 1 ? "" : "s"} for this session: ${normalized.join(", ")}. Read \`<root>/<skill-name>/SKILL.md\` on demand when a named skill is relevant.`;
}
