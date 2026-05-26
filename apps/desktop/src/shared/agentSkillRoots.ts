export const ADE_AGENT_SKILLS_DIRS_ENV = "ADE_AGENT_SKILLS_DIRS";

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

export function getAdeAgentSkillRootCandidates(options: {
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string | null;
  cwd?: string | null;
  dirname?: string | null;
  includeDeepSourceFallbacks?: boolean;
} = {}): string[] {
  const proc = processRef();
  const env = options.env ?? proc?.env ?? {};
  const roots: string[] = [];
  const seen = new Set<string>();

  const cwd = options.cwd ?? (typeof proc?.cwd === "function" ? proc.cwd() : null);
  const processCwd = typeof proc?.cwd === "function" ? proc.cwd() : null;
  for (const rootCwd of [cwd, processCwd]) {
    if (!rootCwd) continue;
    // Prefer the active lane worktree before inherited app roots.
    addPath(roots, seen, joinPath(rootCwd, "apps", "desktop", "resources", "agent-skills"));
    addPath(roots, seen, joinPath(rootCwd, "resources", "agent-skills"));
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

export function getAdeAgentSkillRootsForPrompt(options: {
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string | null;
  cwd?: string | null;
} = {}): string[] {
  return getAdeAgentSkillRootCandidates(options).slice(0, promptAgentSkillRootLimit);
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
