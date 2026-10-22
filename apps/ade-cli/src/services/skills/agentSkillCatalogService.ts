import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import {
  getAgentSkillRootsWithSource,
  type AgentSkillRootSource,
} from "../../../../desktop/src/shared/agentSkillRoots";

export type AgentSkillEntry = {
  name: string;
  description: string;
  path: string;
  source: AgentSkillRootSource;
};

type ParsedSkillFile = {
  name: string | null;
  description: string;
  body: string;
};

type CatalogSkill = {
  entry: AgentSkillEntry;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** The whole SKILL.md, frontmatter included. */
  content: string;
};

type MemoizedCatalog = {
  expiresAt: number;
  skills: CatalogSkill[];
};

const CATALOG_MEMO_TTL_MS = 5_000;
const CATALOG_MEMO_MAX_ENTRIES = 32;
const catalogMemo = new Map<string, MemoizedCatalog>();

function parseSkillFile(content: string, fallbackName: string): ParsedSkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) {
    return { name: fallbackName, description: "", body: content };
  }
  const [, frontmatter, body] = match;
  let name: string | null = null;
  let description = "";
  try {
    const data = parseYaml(frontmatter) as Record<string, unknown> | null;
    if (data && typeof data === "object") {
      if (typeof data.name === "string") name = data.name.trim();
      if (typeof data.description === "string") description = data.description.trim();
    }
  } catch {
    // Fall through to a minimal line-based parse below.
  }
  if (name == null && !description) {
    for (const line of frontmatter.split(/\r?\n/)) {
      const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2].trim().replace(/^["']|["']$/g, "");
      if (key === "name" && !name) name = value;
      if (key === "description" && !description) description = value;
    }
  }
  return { name: name ?? fallbackName, description, body: body.replace(/^\r?\n/, "") };
}

function normalizedSkillName(value: string): string {
  return value.trim().replace(/^\/+/, "").trim().toLowerCase();
}

function canonicalRootKey(root: string): string {
  const canonical = fs.realpathSync.native(root);
  return process.platform === "win32"
    ? path.normalize(canonical).toLowerCase()
    : path.normalize(canonical);
}

function skillDirectoryExists(root: string, dirent: fs.Dirent): boolean {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(root, dirent.name)).isDirectory();
  } catch {
    return false;
  }
}

function buildCatalog(cwd: string, includeUser: boolean, env?: NodeJS.ProcessEnv): CatalogSkill[] {
  const roots = getAgentSkillRootsWithSource({
    cwd,
    env,
    includeDeepSourceFallbacks: true,
  }).filter((candidate) => includeUser || candidate.source !== "user");
  const seenRoots = new Set<string>();
  const byName = new Map<string, CatalogSkill>();

  for (const candidate of roots) {
    let rootKey: string;
    let dirents: fs.Dirent[];
    try {
      if (!fs.statSync(candidate.root).isDirectory()) continue;
      rootKey = canonicalRootKey(candidate.root);
      if (seenRoots.has(rootKey)) continue;
      seenRoots.add(rootKey);
      dirents = fs.readdirSync(candidate.root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      if (!skillDirectoryExists(candidate.root, dirent)) continue;
      const skillPath = path.join(candidate.root, dirent.name, "SKILL.md");
      let content: string;
      try {
        content = fs.readFileSync(skillPath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillFile(content, dirent.name);
      const name = parsed.name ?? dirent.name;
      const nameKey = normalizedSkillName(name);
      if (!nameKey || byName.has(nameKey)) continue;
      byName.set(nameKey, {
        entry: {
          name,
          description: parsed.description,
          path: skillPath,
          source: candidate.source,
        },
        body: parsed.body,
        content,
      });
    }
  }

  return [...byName.values()].sort((left, right) => left.entry.name.localeCompare(right.entry.name));
}

function catalogFor(cwd: string, includeUser: boolean, env?: NodeJS.ProcessEnv): CatalogSkill[] {
  const resolvedCwd = path.resolve(cwd);
  const cacheKey = `${resolvedCwd}\0${includeUser ? "user" : "no-user"}`;
  const now = Date.now();
  const cached = catalogMemo.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.skills;
  if (cached) catalogMemo.delete(cacheKey);

  for (const [key, value] of catalogMemo) {
    if (value.expiresAt <= now) catalogMemo.delete(key);
  }
  while (catalogMemo.size >= CATALOG_MEMO_MAX_ENTRIES) {
    const oldestKey = catalogMemo.keys().next().value;
    if (oldestKey === undefined) break;
    catalogMemo.delete(oldestKey);
  }

  const skills = buildCatalog(resolvedCwd, includeUser, env);
  catalogMemo.set(cacheKey, { expiresAt: Date.now() + CATALOG_MEMO_TTL_MS, skills });
  return skills;
}

export function listAgentSkills(options: {
  cwd: string;
  includeUser: boolean;
  env?: NodeJS.ProcessEnv;
}): AgentSkillEntry[] {
  return catalogFor(options.cwd, options.includeUser, options.env).map(({ entry }) => ({ ...entry }));
}

export function readAgentSkill(
  name: string,
  options: { cwd: string; includeUser: boolean; env?: NodeJS.ProcessEnv },
): { entry: AgentSkillEntry; body: string; content: string } | null {
  const nameKey = normalizedSkillName(name);
  if (!nameKey) return null;
  const skill = catalogFor(options.cwd, options.includeUser, options.env)
    .find((candidate) => normalizedSkillName(candidate.entry.name) === nameKey);
  if (!skill) return null;
  return { entry: { ...skill.entry }, body: skill.body, content: skill.content };
}

export function isRemoteMcpInvocation(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.ADE_REMOTE_MCP_CONNECTION_ID === "string"
    && env.ADE_REMOTE_MCP_CONNECTION_ID.trim().length > 0;
}
