/**
 * What a provider's agent receives when an ADE chat starts, as the machine
 * that runs this code sees it: ADE's own text (exact, from the real builders),
 * the user's and the project's files the provider loads by its documented
 * rules (estimated), the provider's own prompt and tools (unknown, or the rest
 * of the measured first turn), and the median first-turn size of recent chats
 * from the turn ledger. Read-only and bounded: no provider or MCP server is
 * started, no credential or config value is read into the result, and a
 * missing file is simply not listed.
 *
 * Runs on the brain of the machine the Settings page names (the
 * `ai.getProviderContextInventory` action), because every path here is that
 * machine's.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AdeTurnUsageRecord } from "../../../shared/types/turnUsage";
import type {
  GetProviderContextInventoryArgs,
  ProviderContextCoverage,
  ProviderContextItem,
  ProviderContextItemKind,
  ProviderContextMeasurement,
  ProviderContextInventory,
  ProviderContextOwner,
  ProviderContextTiming,
} from "../../../shared/types/providerContext";
import { parseJsonc } from "../../../shared/theme/jsonc";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { AdeChatContextPart, AdeChatContextPreview } from "../chat/adeChatContextPreview";
import {
  firstMarkdownParagraph,
  frontmatterFlag,
  readFrontmatter,
  stripFrontmatter,
} from "../chat/markdownSlashCommandDiscovery";
import { parseCodexMcpServers } from "../mcp/mcpProviderConfigScan";
import {
  claudeConfigHome,
  codexConfigHome,
  copilotConfigHome,
  factoryConfigHome,
  grokConfigHome,
  kimiCodeConfigHome,
  qwenConfigHome,
} from "../shared/providerConfigHomes";
import { getSharedTurnUsageLedger } from "../usage/turnUsageLedger";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** An instruction or rule file larger than this is counted from its first part. */
const MAX_TEXT_BYTES = 512 * 1024;
/** A SKILL.md or agent file: only its frontmatter and first paragraph are listed. */
const MAX_HEADER_BYTES = 32 * 1024;
/** `~/.claude.json` keeps chat history and can be large; it must be parsed whole. */
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES_PER_DIR = 300;
const MAX_RULE_FILES = 200;
const MAX_RULE_DEPTH = 4;
const MAX_ANCESTORS = 40;
const MAX_IMPORT_DEPTH = 5;
/** Claude loads the first 200 lines of MEMORY.md at start. */
const CLAUDE_MEMORY_LINES = 200;
/** Codex's default `project_doc_max_bytes`. */
const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;
/** Kimi's documented AGENTS.md budget. */
const KIMI_AGENTS_MAX_BYTES = 32 * 1024;
const MEASURE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * The one token estimate this list uses: four characters a token. It is the
 * common rule of thumb for English and code; the provider's own tokenizer can
 * differ by a fifth either way.
 */
export function estimateTextTokens(text: string): number {
  return text ? Math.round(text.length / 4) : 0;
}

export type ProviderContextInventoryDeps = {
  projectRoot: string;
  agentChatService?: {
    previewNewChatAdeContext?: (args: { provider: string; laneId?: string | null }) => Promise<AdeChatContextPreview>;
  } | null;
  logger?: { warn: (event: string, data?: Record<string, unknown>) => void } | null;
  /** The turn ledger's rows since `sinceMs`. Defaults to this machine's shared ledger. */
  readTurns?: (sinceMs: number) => Promise<AdeTurnUsageRecord[]>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nowMs?: () => number;
};

export const PROVIDER_CONTEXT_PROVIDERS = [
  "claude", "codex", "cursor", "droid", "opencode", "pi", "muse",
  "qwen", "kimi", "grok", "copilot", "devin", "antigravity",
] as const;

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
  muse: "Muse",
  qwen: "Qwen Code",
  kimi: "Kimi Code",
  grok: "Grok",
  copilot: "Copilot",
  devin: "Devin",
  antigravity: "Antigravity",
};

const GOOD_COVERAGE = new Set(["claude", "codex", "copilot", "opencode", "pi", "cursor", "droid", "qwen", "kimi"]);

const COVERAGE_NOTES: Record<string, string> = {
  claude: "ADE's text is exact; CLAUDE.md files, rules, memory, skills, agents, plugins and MCP servers follow Claude Code's documented rules, so their sizes are estimates and MCP tool sizes are unknown until the servers connect.",
  codex: "ADE's text is exact; AGENTS.md files, skills and MCP servers follow Codex's documented rules, so their sizes are estimates and Codex's own prompt and tools are only known from measured chats.",
  copilot: "ADE's text is exact; instruction files, skills, agents and MCP servers follow Copilot's documented rules, so their sizes are estimates.",
  opencode: "ADE's text is exact; AGENTS.md, skills, agents, plugins and MCP servers follow OpenCode's documented rules, so their sizes are estimates and plugins can change the prompt in ways no list can show.",
  pi: "ADE replaces Pi's base prompt, so most of it is exact; context files, the append file and ADE's skills follow Pi's loader, and Pi's own tools are not counted.",
  cursor: "ADE's text is exact; project rules, AGENTS.md, skills and MCP servers follow Cursor's documented rules, while user and team rules kept in Cursor's settings cannot be read here.",
  droid: "ADE's text is exact; AGENTS.md and CLAUDE.md files, skills, custom droids and MCP servers follow Droid's rules, so their sizes are estimates.",
  qwen: "ADE's text is exact; QWEN.md files, skills and MCP servers follow Qwen Code's documented settings, so their sizes are estimates.",
  kimi: "ADE's text is exact; AGENTS.md files, skills and MCP servers follow Kimi Code's documented rules, so their sizes are estimates.",
  grok: "Only ADE's own text and the MCP servers in Grok's config are listed: Grok does not document what else it loads.",
  devin: "Only ADE's own text and the MCP servers in Devin's config are listed: Devin does not document what else it loads.",
  antigravity: "Only ADE's own text and the MCP servers in Antigravity's config are listed: its harness does not document what else it loads.",
  muse: "Only ADE's own text is listed: Muse lists its skills and plugins only inside a running session.",
};

// ---------------------------------------------------------------------------
// Bounded, async file reads
// ---------------------------------------------------------------------------

type Ctx = {
  provider: string;
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  /** The repository the cwd is in (its worktree root), or null. */
  gitRoot: string | null;
  /** The main checkout of that repository (differs from gitRoot in a linked worktree). */
  mainRoot: string | null;
  logger: ProviderContextInventoryDeps["logger"];
  nextId: (prefix: string) => string;
};

const EXPECTED_FS_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EISDIR"]);

function warnUnexpected(ctx: Pick<Ctx, "logger">, event: string, target: string, error: unknown): void {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code && EXPECTED_FS_CODES.has(code)) return;
  ctx.logger?.warn(event, { path: target, error: error instanceof Error ? error.message : String(error) });
}

type ReadText = { text: string; truncated: boolean; bytes: number };

async function readTextCapped(ctx: Pick<Ctx, "logger">, file: string, maxBytes = MAX_TEXT_BYTES): Promise<ReadText | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return null;
    handle = await fs.promises.open(file, "r");
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, ""),
      truncated: stat.size > maxBytes,
      bytes: stat.size,
    };
  } catch (error) {
    warnUnexpected(ctx, "provider_context.read_failed", file, error);
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJsonCapped(ctx: Pick<Ctx, "logger">, file: string): Promise<Record<string, unknown> | null> {
  const read = await readTextCapped(ctx, file, MAX_CONFIG_BYTES);
  if (!read || read.truncated) return null;
  try {
    const parsed = parseJsonc(read.text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // A config file that is not valid JSON is the provider's to report.
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function listDir(ctx: Pick<Ctx, "logger">, dir: string): Promise<fs.Dirent[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_ENTRIES_PER_DIR);
  } catch (error) {
    warnUnexpected(ctx, "provider_context.list_failed", dir, error);
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A file or folder's shown path and its full path, for "Show in Finder". */
function located(ctx: Ctx, target: string): { source: string; path: string } {
  return { source: displayPath(ctx.home, target), path: path.resolve(target) };
}

function displayPath(home: string, target: string): string {
  const resolved = path.resolve(target);
  if (resolved === home) return "~";
  return resolved.startsWith(home + path.sep) ? `~${resolved.slice(home.length)}` : resolved;
}

// ---------------------------------------------------------------------------
// Repository layout
// ---------------------------------------------------------------------------

async function findGitRoot(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    if (await exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** For a linked worktree, the main checkout (its `.git` file points at `<main>/.git/worktrees/<name>`). */
async function findMainRoot(ctx: Pick<Ctx, "logger">, gitRoot: string | null): Promise<string | null> {
  if (!gitRoot) return null;
  const dotGit = await readTextCapped(ctx, path.join(gitRoot, ".git"), 4096);
  const pointer = dotGit?.text.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
  if (!pointer) return gitRoot;
  const gitDir = path.resolve(gitRoot, pointer.trim());
  const commonDir = (await readTextCapped(ctx, path.join(gitDir, "commondir"), 4096))?.text.trim();
  const common = commonDir ? path.resolve(gitDir, commonDir) : gitDir;
  return path.basename(common) === ".git" ? path.dirname(common) : gitRoot;
}

/** `top` down to `cwd`, both included; just `[cwd]` when there is no top. */
function dirsTopDown(cwd: string, top: string | null): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    dirs.push(dir);
    if (!top || dir === path.resolve(top)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs.reverse();
}

/** Every ancestor from the filesystem root (excluded) down to `cwd`. */
function allAncestorsTopDown(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dirs.push(dir);
    dir = parent;
  }
  return dirs.reverse();
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

function item(ctx: Ctx, fields: {
  owner: ProviderContextOwner;
  kind: ProviderContextItemKind;
  label: string;
  source?: string | null;
  path?: string | null;
  setIn?: string | null;
  settingsEntry?: string | null;
  tokens: number | null;
  sizeKind?: ProviderContextItem["sizeKind"];
  timing: ProviderContextTiming;
  detail?: string | null;
  children?: ProviderContextItem[];
}): ProviderContextItem {
  return {
    id: ctx.nextId(fields.kind),
    owner: fields.owner,
    kind: fields.kind,
    label: fields.label,
    source: fields.source ?? null,
    ...(fields.path ? { path: fields.path } : {}),
    ...(fields.setIn ? { setIn: fields.setIn } : {}),
    ...(fields.settingsEntry ? { settingsEntry: fields.settingsEntry } : {}),
    tokens: fields.tokens,
    sizeKind: fields.sizeKind ?? (fields.tokens == null ? "unknown" : "estimated"),
    timing: fields.timing,
    detail: fields.detail ?? null,
    ...(fields.children?.length ? { children: fields.children } : {}),
  };
}

function sumTokens(items: readonly ProviderContextItem[]): number {
  return items.reduce((total, entry) => total + (entry.tokens ?? 0), 0);
}

function ownerFor(ctx: Ctx, file: string): ProviderContextOwner {
  const resolved = path.resolve(file);
  const roots = [ctx.cwd, ctx.gitRoot, ctx.mainRoot].filter((root): root is string => Boolean(root));
  return roots.some((root) => resolved === root || resolved.startsWith(path.resolve(root) + path.sep)) ? "project" : "user";
}

/** An instruction file as one item, or null when it is missing or empty. */
async function instructionFile(ctx: Ctx, file: string, options: {
  label: string;
  timing?: ProviderContextTiming;
  detail?: string | null;
  maxBytes?: number;
  maxLines?: number;
  kind?: ProviderContextItemKind;
  owner?: ProviderContextOwner;
}): Promise<{ item: ProviderContextItem; text: string } | null> {
  const read = await readTextCapped(ctx, file, options.maxBytes ?? MAX_TEXT_BYTES);
  if (!read) return null;
  let text = read.text;
  let detail = options.detail ?? null;
  if (options.maxLines != null) {
    const lines = text.split(/\r?\n/);
    if (lines.length > options.maxLines) {
      text = lines.slice(0, options.maxLines).join("\n");
      detail = `Only the first ${options.maxLines} of its ${lines.length} lines are loaded.`;
    }
  } else if (read.truncated) {
    detail = `Only the first ${Math.round((options.maxBytes ?? MAX_TEXT_BYTES) / 1024)} KB of this ${Math.round(read.bytes / 1024)} KB file is counted.`;
  }
  if (!text.trim()) return null;
  return {
    text,
    item: item(ctx, {
      owner: options.owner ?? ownerFor(ctx, file),
      kind: options.kind ?? "instructions",
      label: options.label,
      ...located(ctx, file),
      tokens: estimateTextTokens(text),
      timing: options.timing ?? "every-request",
      detail,
    }),
  };
}

/** The first file of `names` in `dir` that has text. */
async function firstInstructionFile(
  ctx: Ctx,
  dir: string,
  names: readonly string[],
  label: (name: string) => string,
  options: Omit<Parameters<typeof instructionFile>[2], "label"> = {},
): Promise<ProviderContextItem | null> {
  for (const name of names) {
    const found = await instructionFile(ctx, path.join(dir, name), { ...options, label: label(name) });
    if (found) return found.item;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claude CLAUDE.md imports
// ---------------------------------------------------------------------------

/** `@path` imports outside code: the forms Claude Code documents. */
function claudeImportTargets(markdown: string): string[] {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const targets: string[] = [];
  for (const match of withoutCode.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+[\w\-/])/g)) {
    const target = match[1]!;
    // An email address or a decorator is not an import.
    if (!target.includes("/") && !target.includes(".")) continue;
    targets.push(target);
  }
  return [...new Set(targets)];
}

async function claudeImports(ctx: Ctx, file: string, text: string, depth: number, seen: Set<string>): Promise<ProviderContextItem[]> {
  if (depth > MAX_IMPORT_DEPTH) return [];
  const children: ProviderContextItem[] = [];
  for (const target of claudeImportTargets(text)) {
    const resolved = target.startsWith("~/")
      ? path.join(ctx.home, target.slice(2))
      : path.resolve(path.dirname(file), target);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const found = await instructionFile(ctx, resolved, { label: `Import: ${path.basename(resolved)}`, detail: "Imported with @ from the file above." });
    if (!found) continue;
    const nested = await claudeImports(ctx, resolved, found.text, depth + 1, seen);
    children.push(nested.length
      ? { ...found.item, tokens: (found.item.tokens ?? 0) + sumTokens(nested), children: nested }
      : found.item);
  }
  return children;
}

async function claudeInstructionFile(ctx: Ctx, file: string, label: string, seen: Set<string>): Promise<ProviderContextItem | null> {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) return null;
  seen.add(resolved);
  const found = await instructionFile(ctx, resolved, { label });
  if (!found) return null;
  const imports = await claudeImports(ctx, resolved, found.text, 1, seen);
  if (!imports.length) return found.item;
  return {
    ...found.item,
    tokens: (found.item.tokens ?? 0) + sumTokens(imports),
    detail: `Includes ${imports.length} imported file${imports.length === 1 ? "" : "s"}.`,
    children: imports,
  };
}

// ---------------------------------------------------------------------------
// Skills, agents, rules
// ---------------------------------------------------------------------------

type SkillInfo = { name: string; description: string; file: string; modelInvocable: boolean };

function headerInfo(text: string, fallbackName: string): { name: string; description: string; frontmatter: Record<string, unknown> } {
  const frontmatter = readFrontmatter(text);
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : fallbackName;
  const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
    ? frontmatter.description.trim()
    : firstMarkdownParagraph(stripFrontmatter(text)).trim();
  return { name, description, frontmatter };
}

/** Each `<root>/<name>/SKILL.md`: name and description only, which is what a provider lists. */
async function scanSkillRoot(ctx: Ctx, root: string): Promise<SkillInfo[]> {
  const entries = await listDir(ctx, root);
  const found = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return null;
    const file = path.join(root, entry.name, "SKILL.md");
    const read = await readTextCapped(ctx, file, MAX_HEADER_BYTES);
    if (!read) return null;
    const info = headerInfo(read.text, entry.name);
    return {
      name: info.name,
      description: info.description,
      file,
      modelInvocable: frontmatterFlag(info.frontmatter["disable-model-invocation"]) !== true,
    } satisfies SkillInfo;
  }));
  return found.filter((entry): entry is SkillInfo => entry != null);
}

function skillListingTokens(skill: Pick<SkillInfo, "name" | "description">): number {
  return estimateTextTokens(`- ${skill.name}: ${skill.description}`);
}

/**
 * Skills found under `roots`, first root winning a name, as one item per
 * root with one child per skill. Skills that opt out of model invocation are
 * not listed to the model, so they are left out.
 */
async function skillItems(ctx: Ctx, roots: ReadonlyArray<{ dir: string; label: string; owner?: ProviderContextOwner }>, options: {
  seen?: Set<string>;
  timing?: ProviderContextTiming;
  detail?: string;
} = {}): Promise<ProviderContextItem[]> {
  const seen = options.seen ?? new Set<string>();
  const seenDirs = new Set<string>();
  const items: ProviderContextItem[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root.dir);
    let real = resolved;
    try {
      real = await fs.promises.realpath(resolved);
    } catch {
      continue;
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    const skills = (await scanSkillRoot(ctx, resolved)).filter((skill) => skill.modelInvocable);
    const children: ProviderContextItem[] = [];
    for (const skill of skills) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      children.push(item(ctx, {
        owner: root.owner ?? ownerFor(ctx, skill.file),
        kind: "skill",
        label: skill.name,
        ...located(ctx, skill.file),
        tokens: skillListingTokens(skill),
        timing: options.timing ?? "every-request",
        detail: "Its name and description are listed; the body is read when it is used.",
      }));
    }
    if (!children.length) continue;
    items.push(item(ctx, {
      owner: root.owner ?? ownerFor(ctx, resolved),
      kind: "skills",
      label: root.label,
      ...located(ctx, resolved),
      tokens: sumTokens(children),
      timing: options.timing ?? "every-request",
      detail: options.detail ?? "Names and descriptions; each body loads only when the skill is used.",
      children,
    }));
  }
  return items;
}

/** `*.md` agent profiles in `dir`: name and description, which is what the model is shown. */
async function agentItems(ctx: Ctx, dirs: ReadonlyArray<{ dir: string; label: string }>, suffix = ".md"): Promise<ProviderContextItem[]> {
  const items: ProviderContextItem[] = [];
  const seen = new Set<string>();
  for (const { dir, label } of dirs) {
    const entries = await listDir(ctx, dir);
    const children: ProviderContextItem[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(suffix) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const file = path.join(dir, entry.name);
      const read = await readTextCapped(ctx, file, MAX_HEADER_BYTES);
      if (!read) continue;
      const info = headerInfo(read.text, entry.name.slice(0, -suffix.length).replace(/\.agent$/, ""));
      if (seen.has(info.name)) continue;
      seen.add(info.name);
      children.push(item(ctx, {
        owner: ownerFor(ctx, file),
        kind: "agent",
        label: info.name,
        ...located(ctx, file),
        tokens: estimateTextTokens(`- ${info.name}: ${info.description}`),
        timing: "every-request",
        detail: "Its name and description are listed; its instructions load when it runs.",
      }));
    }
    if (!children.length) continue;
    items.push(item(ctx, {
      owner: ownerFor(ctx, dir),
      kind: "agent",
      label,
      ...located(ctx, dir),
      tokens: sumTokens(children),
      timing: "every-request",
      children,
    }));
  }
  return items;
}

/** Markdown rule files under `dir`, a few levels deep. */
async function ruleFiles(ctx: Ctx, dir: string, extensions: readonly string[], depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_RULE_DEPTH || out.length >= MAX_RULE_FILES) return out;
  for (const entry of await listDir(ctx, dir)) {
    if (out.length >= MAX_RULE_FILES) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await ruleFiles(ctx, full, extensions, depth + 1, out);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/**
 * Rule files as items. `conditional(frontmatter)` says when a rule only
 * reaches the model on a matching file (path rules), so it is on-demand.
 */
async function ruleItems(ctx: Ctx, dirs: ReadonlyArray<{ dir: string; label: string }>, extensions: readonly string[], conditional: (frontmatter: Record<string, unknown>) => boolean): Promise<ProviderContextItem[]> {
  const items: ProviderContextItem[] = [];
  for (const { dir, label } of dirs) {
    const files = await ruleFiles(ctx, dir, extensions);
    const children: ProviderContextItem[] = [];
    for (const file of files) {
      const read = await readTextCapped(ctx, file);
      if (!read?.text.trim()) continue;
      const scoped = conditional(readFrontmatter(read.text));
      children.push(item(ctx, {
        owner: ownerFor(ctx, file),
        kind: "rule",
        label: path.relative(dir, file),
        ...located(ctx, file),
        tokens: estimateTextTokens(read.text),
        timing: scoped ? "on-demand" : "every-request",
        detail: scoped ? "Loads only when the agent works on files it matches." : null,
      }));
    }
    if (!children.length) continue;
    const always = children.filter((child) => child.timing !== "on-demand");
    items.push(item(ctx, {
      owner: ownerFor(ctx, dir),
      kind: "rule",
      label,
      ...located(ctx, dir),
      tokens: sumTokens(always),
      timing: always.length ? "every-request" : "on-demand",
      detail: always.length < children.length
        ? `${children.length - always.length} of them load only for matching files and are not in the total.`
        : null,
      children,
    }));
  }
  return items;
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

type McpSource = { file: string; format: "json" | "toml"; key?: string; scope: string; projectKey?: string[] };

function mcpType(entry: unknown): string {
  if (!isRecord(entry)) return "unknown";
  const declared = typeof entry.type === "string" ? entry.type : typeof entry.transport === "string" ? entry.transport : null;
  if (declared) return declared === "streamable-http" || declared === "streamableHttp" ? "http" : declared;
  if (typeof entry.command === "string" || Array.isArray(entry.command)) return "stdio";
  if (typeof entry.httpUrl === "string") return "http";
  if (typeof entry.url === "string" || typeof entry.serverUrl === "string") return "http";
  return "unknown";
}

function mcpDisabled(entry: unknown): boolean {
  return isRecord(entry) && (entry.disabled === true || entry.enabled === false);
}

/** Server names and types only: no command, argument, URL, env or header value leaves this function. */
async function mcpItems(ctx: Ctx, sources: readonly McpSource[], options: { seen?: Set<string>; detail?: string } = {}): Promise<ProviderContextItem[]> {
  const seen = options.seen ?? new Set<string>();
  const items: ProviderContextItem[] = [];
  for (const source of sources) {
    let table: Record<string, unknown> | null = null;
    if (source.format === "toml") {
      const read = await readTextCapped(ctx, source.file, MAX_CONFIG_BYTES);
      table = read ? parseCodexMcpServers(read.text) : null;
    } else {
      let node: unknown = await readJsonCapped(ctx, source.file);
      for (const key of source.projectKey ?? []) node = isRecord(node) ? node[key] : null;
      table = isRecord(node) && source.key ? (isRecord(node[source.key]) ? node[source.key] as Record<string, unknown> : null) : null;
    }
    if (!table) continue;
    for (const [rawName, entry] of Object.entries(table)) {
      const name = rawName.trim();
      if (!name || seen.has(name) || mcpDisabled(entry)) continue;
      seen.add(name);
      items.push(item(ctx, {
        owner: source.scope === "project" ? "project" : "user",
        kind: "mcp-server",
        label: `MCP server: ${name}`,
        setIn: `${displayPath(ctx.home, source.file)}${source.scope === "local" ? " (this project)" : ""}`,
        path: path.resolve(source.file),
        settingsEntry: "mcp.found",
        tokens: null,
        timing: "every-request",
        detail: options.detail ?? `${mcpType(entry)} server. Its tools and instructions arrive when it connects, so their size is not known here.`,
      }));
    }
  }
  return items;
}

function adeMcpItems(ctx: Ctx, servers: AdeChatContextPreview["mcpServers"], seen: Set<string>): ProviderContextItem[] {
  const items: ProviderContextItem[] = [];
  for (const server of servers) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    items.push(item(ctx, {
      owner: "user",
      kind: "mcp-server",
      label: `MCP server: ${server.name}`,
      setIn: "ADE Settings › MCP servers",
      settingsEntry: "mcp.servers",
      tokens: null,
      timing: "every-request",
      detail: `${server.type} server ADE starts for this chat. Its tools arrive when it connects, so their size is not known here.`,
    }));
  }
  return items;
}

// ---------------------------------------------------------------------------
// Per provider
// ---------------------------------------------------------------------------

type ProviderItems = { items: ProviderContextItem[]; adeSkillsNative: boolean };

function homeEnv(ctx: Ctx): { env: NodeJS.ProcessEnv; homeDir: string } {
  return { env: ctx.env, homeDir: ctx.home };
}

async function claudeItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const configDir = claudeConfigHome(homeEnv(ctx));
  const items: ProviderContextItem[] = [];
  const seenFiles = new Set<string>();

  // CLAUDE.md: managed policy, user, then every ancestor down to the cwd.
  const managed = process.platform === "darwin"
    ? "/Library/Application Support/ClaudeCode/CLAUDE.md"
    : process.platform === "win32"
      ? path.join(ctx.env.ProgramFiles?.trim() || "C:\\Program Files", "ClaudeCode", "CLAUDE.md")
      : "/etc/claude-code/CLAUDE.md";
  const managedItem = await claudeInstructionFile(ctx, managed, "Managed CLAUDE.md", seenFiles);
  if (managedItem) items.push({ ...managedItem, owner: "user" });
  const userItem = await claudeInstructionFile(ctx, path.join(configDir, "CLAUDE.md"), "User CLAUDE.md", seenFiles);
  if (userItem) items.push(userItem);
  for (const dir of allAncestorsTopDown(ctx.cwd)) {
    if (path.resolve(dir) === ctx.home) continue;
    const where = dir === ctx.cwd ? "Project" : `Parent folder ${path.basename(dir)}`;
    for (const [rel, label] of [
      ["CLAUDE.md", `${where} CLAUDE.md`],
      [path.join(".claude", "CLAUDE.md"), `${where} .claude/CLAUDE.md`],
      ["CLAUDE.local.md", `${where} CLAUDE.local.md`],
    ] as const) {
      const found = await claudeInstructionFile(ctx, path.join(dir, rel), label, seenFiles);
      if (found) items.push(found);
    }
  }

  // Rules: user, then the project's.
  const ruleDirs = [
    { dir: path.join(configDir, "rules"), label: "User rules" },
    ...dirsTopDown(ctx.cwd, ctx.gitRoot).map((dir) => ({ dir: path.join(dir, ".claude", "rules"), label: "Project rules" })),
  ];
  items.push(...await ruleItems(ctx, ruleDirs, [".md"], (fm) => fm.paths != null || fm.globs != null));

  // Settings, merged user < project < local, for the few keys that decide what loads.
  const settingsFiles = [
    path.join(configDir, "settings.json"),
    ...(ctx.gitRoot ? [path.join(ctx.gitRoot, ".claude", "settings.json"), path.join(ctx.gitRoot, ".claude", "settings.local.json")] : []),
  ];
  const enabledPlugins = new Map<string, boolean>();
  let autoMemory = true;
  let outputStyle: string | null = null;
  for (const file of settingsFiles) {
    const settings = await readJsonCapped(ctx, file);
    if (!settings) continue;
    if (isRecord(settings.enabledPlugins)) {
      for (const [key, value] of Object.entries(settings.enabledPlugins)) enabledPlugins.set(key, value === true);
    }
    if (settings.autoMemoryEnabled === false) autoMemory = false;
    if (settings.autoMemoryEnabled === true) autoMemory = true;
    if (typeof settings.outputStyle === "string") outputStyle = settings.outputStyle;
  }
  if (ctx.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1" || ctx.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "true") autoMemory = false;

  // Auto memory: the first 200 lines of the project's MEMORY.md.
  if (autoMemory) {
    const slug = (dir: string) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
    const candidates = [...new Set([ctx.mainRoot, ctx.gitRoot, ctx.cwd].filter((dir): dir is string => Boolean(dir)))];
    for (const dir of candidates) {
      const found = await instructionFile(ctx, path.join(configDir, "projects", slug(dir), "memory", "MEMORY.md"), {
        label: "Auto memory (MEMORY.md)",
        kind: "memory",
        owner: "user",
        maxLines: CLAUDE_MEMORY_LINES,
        detail: "Claude's own notes for this project. Other memory files are read only when needed.",
      });
      if (found) {
        items.push(found.item);
        break;
      }
    }
  }

  // Output style, when the user picked one other than the default.
  if (outputStyle && outputStyle.toLowerCase() !== "default") {
    for (const dir of [path.join(ctx.cwd, ".claude", "output-styles"), path.join(configDir, "output-styles")]) {
      const found = await instructionFile(ctx, path.join(dir, `${outputStyle}.md`), {
        label: `Output style: ${outputStyle}`,
        kind: "system-prompt",
        detail: "Changes Claude Code's own prompt; ADE can override it per chat.",
      });
      if (found) {
        items.push(found.item);
        break;
      }
    }
  }

  // Skills Claude reads itself: the user's and each project folder's `.claude/skills`.
  const seenSkills = new Set<string>();
  items.push(...await skillItems(ctx, [
    ...dirsTopDown(ctx.cwd, ctx.gitRoot).reverse().map((dir) => ({ dir: path.join(dir, ".claude", "skills"), label: "Project skills" })),
    { dir: path.join(configDir, "skills"), label: "User skills" },
  ], { seen: seenSkills }));

  // Custom agents.
  items.push(...await agentItems(ctx, [
    { dir: path.join(ctx.cwd, ".claude", "agents"), label: "Project agents" },
    { dir: path.join(configDir, "agents"), label: "User agents" },
  ]));

  // Plugins the settings enable, with the skills, agents and commands each one lists.
  const installed = await readJsonCapped(ctx, path.join(configDir, "plugins", "installed_plugins.json"));
  const installedTable = isRecord(installed?.plugins) ? installed.plugins : {};
  for (const [key, enabled] of enabledPlugins) {
    if (!enabled) continue;
    const records = installedTable[key];
    const list = Array.isArray(records) ? records.filter(isRecord) : isRecord(records) ? [records] : [];
    const record = list.find((entry) => entry.scope === "user") ?? list[list.length - 1];
    const installPath = typeof record?.installPath === "string" ? record.installPath : null;
    const children: ProviderContextItem[] = [];
    if (installPath) {
      const pluginName = key.split("@")[0] ?? key;
      for (const skillItem of await skillItems(ctx, [{ dir: path.join(installPath, "skills"), label: "Skills", owner: "user" }])) {
        children.push(...(skillItem.children ?? []).map((child) => ({ ...child, label: `${pluginName}:${child.label}` })));
      }
      for (const agentItem of await agentItems(ctx, [{ dir: path.join(installPath, "agents"), label: "Agents" }])) {
        children.push(...(agentItem.children ?? []).map((child) => ({ ...child, owner: "user" as const })));
      }
      for (const commandItem of await agentItems(ctx, [{ dir: path.join(installPath, "commands"), label: "Commands" }])) {
        children.push(...(commandItem.children ?? []).map((child) => ({ ...child, owner: "user" as const, kind: "other" as const })));
      }
      if (await exists(path.join(installPath, ".mcp.json"))) {
        children.push(item(ctx, {
          owner: "user",
          kind: "mcp-server",
          label: "Plugin MCP servers",
          ...located(ctx, path.join(installPath, ".mcp.json")),
          tokens: null,
          timing: "every-request",
          detail: "Tools arrive when the servers connect.",
        }));
      }
    }
    items.push(item(ctx, {
      owner: "user",
      kind: "plugin",
      label: `Plugin: ${key}`,
      ...(installPath ? located(ctx, installPath) : { setIn: "settings.json › enabledPlugins" }),
      tokens: children.some((child) => child.tokens != null) ? sumTokens(children) : null,
      timing: "every-request",
      detail: installPath ? "Its skills, agents and commands are listed by name and description." : "Enabled, but not installed on this computer.",
      children,
    }));
  }

  // MCP servers: the launch's config home, the machine login's (an ADE account
  // home is handed those too), and the project's `.mcp.json`.
  const seenMcp = new Set<string>();
  const projectKeys = [...new Set([ctx.cwd, ctx.gitRoot, ctx.mainRoot].filter((dir): dir is string => Boolean(dir)))];
  const claudeJsonFiles = [...new Set([
    ctx.env.CLAUDE_CONFIG_DIR?.trim() ? path.join(configDir, ".claude.json") : path.join(ctx.home, ".claude.json"),
    path.join(ctx.home, ".claude.json"),
  ])];
  const mcpSources: McpSource[] = [];
  for (const file of claudeJsonFiles) {
    for (const key of projectKeys) mcpSources.push({ file, format: "json", key: "mcpServers", scope: "local", projectKey: ["projects", key] });
    mcpSources.push({ file, format: "json", key: "mcpServers", scope: "user" });
  }
  mcpSources.push({ file: path.join(ctx.gitRoot ?? ctx.cwd, ".mcp.json"), format: "json", key: "mcpServers", scope: "project" });
  items.push(...adeMcpItems(ctx, preview?.mcpServers ?? [], seenMcp));
  items.push(...await mcpItems(ctx, mcpSources, { seen: seenMcp }));

  return { items, adeSkillsNative: true };
}

function parseTomlTopLevel(text: string): { maxBytes: number | null; fallbacks: string[] } {
  const top = text.split(/^\s*\[/m)[0] ?? "";
  const max = top.match(/^\s*project_doc_max_bytes\s*=\s*(\d+)/m)?.[1];
  const fallbacks = top.match(/^\s*project_doc_fallback_filenames\s*=\s*\[([^\]]*)\]/m)?.[1];
  return {
    maxBytes: max ? Number(max) : null,
    fallbacks: fallbacks ? [...fallbacks.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!) : [],
  };
}

function codexProjectTrusted(text: string, dirs: readonly string[]): boolean {
  for (const dir of dirs) {
    const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const section = text.match(new RegExp(`^\\s*\\[projects\\.["']${escaped}["']\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|$(?![\\s\\S]))`, "m"))?.[1];
    if (section && /^\s*trust_level\s*=\s*["']trusted["']/m.test(section)) return true;
  }
  return false;
}

async function codexItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const home = codexConfigHome(homeEnv(ctx));
  const items: ProviderContextItem[] = [];
  const configText = (await readTextCapped(ctx, path.join(home, "config.toml"), MAX_CONFIG_BYTES))?.text ?? "";
  const { maxBytes, fallbacks } = parseTomlTopLevel(configText);
  const cap = maxBytes ?? CODEX_PROJECT_DOC_MAX_BYTES;

  const globalDoc = await firstInstructionFile(ctx, home, ["AGENTS.override.md", "AGENTS.md"], (name) => `Global ${name}`);
  if (globalDoc) items.push(globalDoc);

  // Project docs, root to cwd, one per folder, under one shared byte cap.
  let used = 0;
  if (cap > 0) {
    for (const dir of dirsTopDown(ctx.cwd, ctx.gitRoot)) {
      const found = await firstInstructionFile(ctx, dir, ["AGENTS.override.md", "AGENTS.md", ...fallbacks],
        (name) => `${dir === ctx.cwd ? "Project" : `Folder ${path.basename(dir)}`} ${name}`);
      if (!found) continue;
      const bytes = (found.tokens ?? 0) * 4;
      if (used >= cap) {
        items.push({ ...found, tokens: 0, detail: `Not loaded: project_doc_max_bytes (${cap} bytes) is already used up.` });
        continue;
      }
      if (used + bytes > cap) {
        items.push({ ...found, tokens: Math.round((cap - used) / 4), detail: `Cut at project_doc_max_bytes (${cap} bytes).` });
        used = cap;
        continue;
      }
      used += bytes;
      items.push(found);
    }
  }

  const seenSkills = new Set<string>();
  items.push(...await skillItems(ctx, [
    ...dirsTopDown(ctx.cwd, ctx.gitRoot).reverse().map((dir) => ({ dir: path.join(dir, ".agents", "skills"), label: "Project skills" })),
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User skills" },
    { dir: path.join(home, "skills"), label: "Codex skills" },
  ], { seen: seenSkills, detail: "Names and descriptions; Codex shortens them when the list is long." }));

  const seenMcp = new Set<string>();
  items.push(...adeMcpItems(ctx, preview?.mcpServers ?? [], seenMcp));
  const projectDirs = [ctx.cwd, ctx.gitRoot, ctx.mainRoot].filter((dir): dir is string => Boolean(dir));
  const sources: McpSource[] = [];
  if (codexProjectTrusted(configText, projectDirs)) {
    for (const dir of dirsTopDown(ctx.cwd, ctx.gitRoot).reverse()) {
      sources.push({ file: path.join(dir, ".codex", "config.toml"), format: "toml", scope: "project" });
    }
  }
  sources.push({ file: path.join(home, "config.toml"), format: "toml", scope: "user" });
  items.push(...await mcpItems(ctx, sources, { seen: seenMcp }));
  return { items, adeSkillsNative: true };
}

async function copilotItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const home = copilotConfigHome(homeEnv(ctx));
  const items: ProviderContextItem[] = [];
  const global = await instructionFile(ctx, path.join(home, "copilot-instructions.md"), { label: "Global copilot-instructions.md" });
  if (global) items.push(global.item);
  const applyTo = (fm: Record<string, unknown>) => {
    const value = fm.applyTo;
    return value != null && !(typeof value === "string" && value.trim() === "**");
  };
  const extraDirs = (ctx.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? "").split(path.delimiter).map((dir) => dir.trim()).filter(Boolean);
  items.push(...await ruleItems(ctx, [
    { dir: path.join(home, "instructions"), label: "Global instructions" },
    ...extraDirs.map((dir) => ({ dir, label: "Extra instructions" })),
  ], [".instructions.md"], applyTo));

  const root = ctx.gitRoot ?? ctx.cwd;
  for (const dir of [...new Set([root, ctx.cwd])]) {
    for (const rel of [path.join(".github", "copilot-instructions.md"), "AGENTS.md", "CLAUDE.md"]) {
      const found = await instructionFile(ctx, path.join(dir, rel), { label: `${dir === root ? "Repository" : "Folder"} ${rel}` });
      if (found) items.push(found.item);
    }
  }
  items.push(...await ruleItems(ctx, [
    { dir: path.join(root, ".github", "instructions"), label: "Repository instructions" },
    { dir: path.join(root, ".claude", "rules"), label: "Repository .claude rules" },
  ], [".md"], (fm) => applyTo(fm) || fm.paths != null));

  const seenSkills = new Set<string>();
  items.push(...await skillItems(ctx, [
    { dir: path.join(ctx.cwd, ".github", "skills"), label: "Project .github skills" },
    { dir: path.join(ctx.cwd, ".agents", "skills"), label: "Project .agents skills" },
    { dir: path.join(ctx.cwd, ".claude", "skills"), label: "Project .claude skills" },
    ...dirsTopDown(ctx.cwd, ctx.gitRoot).reverse().slice(1).map((dir) => ({ dir: path.join(dir, ".github", "skills"), label: "Parent .github skills" })),
    { dir: path.join(home, "skills"), label: "User Copilot skills" },
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User .agents skills" },
  ], { seen: seenSkills }));

  items.push(...await agentItems(ctx, [
    { dir: path.join(root, ".github", "agents"), label: "Repository agents" },
    { dir: path.join(home, "agents"), label: "User agents" },
  ]));

  const seenMcp = new Set<string>();
  items.push(...adeMcpItems(ctx, preview?.mcpServers ?? [], seenMcp));
  items.push(...await mcpItems(ctx, [
    { file: path.join(root, ".mcp.json"), format: "json", key: "mcpServers", scope: "project" },
    { file: path.join(home, "mcp-config.json"), format: "json", key: "mcpServers", scope: "user" },
  ], { seen: seenMcp }));
  return { items, adeSkillsNative: true };
}

async function cursorItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const items: ProviderContextItem[] = [];
  const root = ctx.gitRoot ?? ctx.cwd;
  items.push(...await ruleItems(ctx, [...new Set([root, ctx.cwd])].map((dir) => ({
    dir: path.join(dir, ".cursor", "rules"),
    label: "Project rules",
  })), [".mdc", ".md"], (fm) => frontmatterFlag(fm.alwaysApply) !== true));
  for (const dir of [...new Set([root, ctx.cwd])]) {
    const found = await instructionFile(ctx, path.join(dir, "AGENTS.md"), { label: `${dir === root ? "Project" : "Folder"} AGENTS.md` });
    if (found) items.push(found.item);
  }
  const seenSkills = new Set<string>();
  items.push(...await skillItems(ctx, [
    { dir: path.join(ctx.cwd, ".cursor", "skills"), label: "Project .cursor skills" },
    { dir: path.join(ctx.cwd, ".agents", "skills"), label: "Project .agents skills" },
    { dir: path.join(ctx.home, ".cursor", "skills"), label: "User skills" },
  ], { seen: seenSkills }));
  const seenMcp = new Set<string>();
  items.push(...adeMcpItems(ctx, preview?.mcpServers ?? [], seenMcp));
  items.push(...await mcpItems(ctx, [
    { file: path.join(root, ".cursor", "mcp.json"), format: "json", key: "mcpServers", scope: "project" },
    { file: path.join(ctx.home, ".cursor", "mcp.json"), format: "json", key: "mcpServers", scope: "user" },
  ], { seen: seenMcp }));
  items.push(item(ctx, {
    owner: "user",
    kind: "rule",
    label: "User and team rules",
    setIn: "Cursor Settings › Rules",
    tokens: null,
    timing: "every-request",
    detail: "Kept in Cursor's own settings and account, so they cannot be read here.",
  }));
  return { items, adeSkillsNative: true };
}

async function openCodeItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const items: ProviderContextItem[] = [];
  const configDir = path.join(ctx.env.XDG_CONFIG_HOME?.trim() || path.join(ctx.home, ".config"), "opencode");
  const claudeCompat = ctx.env.OPENCODE_DISABLE_CLAUDE_CODE !== "1" && ctx.env.OPENCODE_DISABLE_CLAUDE_CODE !== "true";
  const claudePrompt = claudeCompat && ctx.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT !== "1" && ctx.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT !== "true";
  const claudeSkills = claudeCompat && ctx.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS !== "1" && ctx.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS !== "true";

  // Project: the first AGENTS.md walking up from the cwd, else CLAUDE.md.
  const projectDirs = dirsTopDown(ctx.cwd, ctx.gitRoot).reverse();
  let projectDoc: ProviderContextItem | null = null;
  for (const name of ["AGENTS.md", ...(claudePrompt ? ["CLAUDE.md"] : [])]) {
    for (const dir of projectDirs) {
      const found = await instructionFile(ctx, path.join(dir, name), { label: `Project ${name}` });
      if (found) {
        projectDoc = found.item;
        break;
      }
    }
    if (projectDoc) break;
  }
  if (projectDoc) items.push(projectDoc);
  const globalDoc = await instructionFile(ctx, path.join(configDir, "AGENTS.md"), { label: "Global AGENTS.md" })
    ?? (claudePrompt ? await instructionFile(ctx, path.join(claudeConfigHome(homeEnv(ctx)), "CLAUDE.md"), { label: "Global CLAUDE.md (Claude Code's)" }) : null);
  if (globalDoc) items.push(globalDoc.item);

  // Config documents: user, then project. `instructions`, `mcp` and `plugin` come from them.
  const configFiles = [
    path.join(configDir, "opencode.json"),
    path.join(configDir, "opencode.jsonc"),
    ...dirsTopDown(ctx.cwd, ctx.gitRoot).flatMap((dir) => [
      path.join(dir, "opencode.json"),
      path.join(dir, "opencode.jsonc"),
      path.join(dir, ".opencode", "opencode.json"),
      path.join(dir, ".opencode", "opencode.jsonc"),
    ]),
  ];
  const seenMcp = new Set<string>();
  items.push(...adeMcpItems(ctx, preview?.mcpServers ?? [], seenMcp));
  const plugins: ProviderContextItem[] = [];
  for (const file of configFiles) {
    const config = await readJsonCapped(ctx, file);
    if (!config) continue;
    for (const entry of Array.isArray(config.instructions) ? config.instructions : []) {
      if (typeof entry !== "string") continue;
      if (/^https?:/i.test(entry) || /[*?[]/.test(entry)) {
        items.push(item(ctx, {
          owner: ownerFor(ctx, file),
          kind: "instructions",
          label: `Instructions: ${/^https?:/i.test(entry) ? "a web address" : entry}`,
          setIn: displayPath(ctx.home, file),
          path: path.resolve(file),
          tokens: null,
          timing: "every-request",
          detail: "A pattern or web address in `instructions`; its size is known only when OpenCode loads it.",
        }));
        continue;
      }
      const target = entry.startsWith("~/") ? path.join(ctx.home, entry.slice(2)) : path.resolve(path.dirname(file), entry);
      const found = await instructionFile(ctx, target, { label: `Instructions: ${path.basename(target)}` });
      if (found) items.push(found.item);
    }
    items.push(...await mcpItems(ctx, [{ file, format: "json", key: "mcp", scope: ownerFor(ctx, file) === "project" ? "project" : "user" }], { seen: seenMcp }));
    for (const entry of Array.isArray(config.plugin) ? config.plugin : []) {
      if (typeof entry !== "string") continue;
      plugins.push(item(ctx, {
        owner: ownerFor(ctx, file),
        kind: "plugin",
        label: `Plugin: ${entry.replace(/^.*\//, "")}`,
        setIn: displayPath(ctx.home, file),
        path: path.resolve(file),
        tokens: null,
        timing: "every-request",
        detail: "A plugin runs code that can add tools or change the prompt; its effect is not known here.",
      }));
    }
  }
  items.push(...plugins);

  const seenSkills = new Set<string>();
  const projectSkillRoots = projectDirs.flatMap((dir) => [
    { dir: path.join(dir, ".opencode", "skills"), label: "Project skills" },
    ...(claudeSkills ? [{ dir: path.join(dir, ".claude", "skills"), label: "Project .claude skills" }] : []),
    { dir: path.join(dir, ".agents", "skills"), label: "Project .agents skills" },
  ]);
  items.push(...await skillItems(ctx, [
    ...projectSkillRoots,
    { dir: path.join(configDir, "skills"), label: "User skills" },
    ...(claudeSkills ? [{ dir: path.join(claudeConfigHome(homeEnv(ctx)), "skills"), label: "User .claude skills" }] : []),
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User .agents skills" },
  ], { seen: seenSkills, detail: "Names and descriptions shown to the skill tool; each body loads when used." }));

  items.push(...await agentItems(ctx, [
    { dir: path.join(ctx.cwd, ".opencode", "agents"), label: "Project agents" },
    { dir: path.join(configDir, "agents"), label: "User agents" },
  ]));
  return { items, adeSkillsNative: true };
}

async function piItems(ctx: Ctx): Promise<ProviderItems> {
  const agentDir = ctx.env.PI_CODING_AGENT_DIR?.trim() ? path.resolve(ctx.env.PI_CODING_AGENT_DIR.trim()) : path.join(ctx.home, ".pi", "agent");
  const items: ProviderContextItem[] = [];
  const names = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  const append = await instructionFile(ctx, path.join(agentDir, "APPEND_SYSTEM.md"), {
    label: "APPEND_SYSTEM.md",
    kind: "system-prompt",
    detail: "Added to the system prompt. ADE runs Pi untrusted, so a project's own file is not read.",
  });
  if (append) items.push(append.item);
  const global = await firstInstructionFile(ctx, agentDir, names, (name) => `Global ${name}`);
  if (global) items.push(global);
  // A linked worktree nested inside its main checkout shadows the main
  // checkout's file of the same name (Pi's `findShadowedContextFile`).
  const nested = ctx.gitRoot && ctx.mainRoot && ctx.gitRoot !== ctx.mainRoot
    && ctx.gitRoot.startsWith(ctx.mainRoot + path.sep);
  let shadowed: string | null = null;
  if (nested) {
    for (const name of names) {
      if (await exists(path.join(ctx.gitRoot!, name))) {
        shadowed = path.join(ctx.mainRoot!, name);
        break;
      }
    }
  }
  for (const dir of allAncestorsTopDown(ctx.cwd)) {
    if (path.resolve(dir) === path.resolve(agentDir)) continue;
    const found = await firstInstructionFile(ctx, dir, names, (name) => `${dir === ctx.cwd ? "Project" : `Folder ${path.basename(dir)}`} ${name}`);
    if (found && !(shadowed && found.source === displayPath(ctx.home, shadowed))) items.push(found);
  }
  items.push(...await mcpItems(ctx, [{ file: path.join(agentDir, "mcp.json"), format: "json", key: "mcpServers", scope: "user" }], {
    detail: "Pi's own MCP config: used only when MCP is on for Pi chats in ADE. Its tools arrive when it connects.",
  }));
  return { items, adeSkillsNative: true };
}

async function droidItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const factory = factoryConfigHome(homeEnv(ctx));
  const items: ProviderContextItem[] = [];
  for (const dir of dirsTopDown(ctx.cwd, ctx.gitRoot)) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const found = await instructionFile(ctx, path.join(dir, name), { label: `${dir === ctx.cwd ? "Project" : `Folder ${path.basename(dir)}`} ${name}` });
      if (found) items.push(found.item);
    }
  }
  const seenSkills = new Set<string>();
  const projectDirs = [...new Set([ctx.cwd, ctx.gitRoot].filter((dir): dir is string => Boolean(dir)))];
  items.push(...await skillItems(ctx, [
    ...projectDirs.flatMap((dir) => [".factory", ".agents", ".agent"].map((sub) => ({ dir: path.join(dir, sub, "skills"), label: `Project ${sub} skills` }))),
    { dir: path.join(factory, "skills"), label: "User .factory skills" },
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User .agents skills" },
    { dir: path.join(ctx.home, ".agent", "skills"), label: "User .agent skills" },
  ], { seen: seenSkills }));
  items.push(...await agentItems(ctx, [
    { dir: path.join(ctx.cwd, ".factory", "droids"), label: "Project droids" },
    { dir: path.join(factory, "droids"), label: "User droids" },
  ]));
  const seenMcp = new Set<string>();
  items.push(...adeMcpItems(ctx, preview?.mcpServers ?? [], seenMcp));
  // `.factory/mcp.json` in the folder and every folder above it, then the user's.
  items.push(...await mcpItems(ctx, [
    ...allAncestorsTopDown(ctx.cwd).reverse().map((dir): McpSource => ({
      file: path.join(dir, ".factory", "mcp.json"),
      format: "json",
      key: "mcpServers",
      scope: ownerFor(ctx, dir) === "project" ? "project" : "user",
    })),
    { file: path.join(factory, "mcp.json"), format: "json", key: "mcpServers", scope: "user" },
  ], { seen: seenMcp }));
  return { items, adeSkillsNative: false };
}

async function qwenItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const home = qwenConfigHome(homeEnv(ctx));
  const items: ProviderContextItem[] = [];
  const userSettings = await readJsonCapped(ctx, path.join(home, "settings.json"));
  const projectSettings = await readJsonCapped(ctx, path.join(ctx.cwd, ".qwen", "settings.json"));
  const contextNames = (() => {
    for (const settings of [projectSettings, userSettings]) {
      const value = isRecord(settings?.context) ? settings.context.fileName : undefined;
      if (typeof value === "string" && value.trim()) return [value.trim()];
      if (Array.isArray(value)) {
        const names = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
        if (names.length) return names;
      }
    }
    return ["QWEN.md"];
  })();
  for (const name of contextNames) {
    const global = await instructionFile(ctx, path.join(home, name), { label: `Global ${name}` });
    if (global) items.push(global.item);
    for (const dir of dirsTopDown(ctx.cwd, ctx.gitRoot)) {
      const found = await instructionFile(ctx, path.join(dir, name), { label: `${dir === ctx.cwd ? "Project" : `Folder ${path.basename(dir)}`} ${name}` });
      if (found) items.push(found.item);
    }
  }
  const disabled = new Set<string>();
  for (const settings of [userSettings, projectSettings]) {
    const list = isRecord(settings?.skills) ? settings.skills.disabled : undefined;
    if (Array.isArray(list)) for (const name of list) if (typeof name === "string") disabled.add(name.toLowerCase());
  }
  const seenSkills = new Set<string>(disabled);
  items.push(...await skillItems(ctx, [
    { dir: path.join(ctx.cwd, ".qwen", "skills"), label: "Project skills" },
    { dir: path.join(ctx.cwd, ".agents", "skills"), label: "Project .agents skills" },
    { dir: path.join(home, "skills"), label: "User skills" },
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User .agents skills" },
  ], { seen: seenSkills }));
  const seenMcp = new Set<string>();
  items.push(...adeMcpItems(ctx, preview?.mcpServers ?? [], seenMcp));
  items.push(...await mcpItems(ctx, [
    { file: path.join(ctx.cwd, ".qwen", "settings.json"), format: "json", key: "mcpServers", scope: "project" },
    { file: path.join(home, "settings.json"), format: "json", key: "mcpServers", scope: "user" },
  ], { seen: seenMcp }));
  return { items, adeSkillsNative: true };
}

async function kimiItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const home = kimiCodeConfigHome(homeEnv(ctx));
  const items: ProviderContextItem[] = [];
  // Root to cwd, deeper files first under one 32 KiB budget.
  const docs: ProviderContextItem[] = [];
  for (const dir of dirsTopDown(ctx.cwd, ctx.gitRoot)) {
    for (const rel of ["AGENTS.md", path.join(".kimi", "AGENTS.md")]) {
      const found = await instructionFile(ctx, path.join(dir, rel), { label: `${dir === ctx.cwd ? "Project" : `Folder ${path.basename(dir)}`} ${rel}` });
      if (found) docs.push(found.item);
    }
  }
  let budget = KIMI_AGENTS_MAX_BYTES / 4;
  for (const doc of [...docs].reverse()) {
    const tokens = doc.tokens ?? 0;
    if (tokens <= budget) {
      budget -= tokens;
      continue;
    }
    Object.assign(doc, { tokens: Math.max(0, Math.round(budget)), detail: "Cut to fit Kimi's 32 KB AGENTS.md budget." });
    budget = 0;
  }
  items.push(...docs);
  const seenSkills = new Set<string>();
  items.push(...await skillItems(ctx, [
    { dir: path.join(ctx.cwd, ".agents", "skills"), label: "Project .agents skills" },
    { dir: path.join(home, "skills"), label: "User skills" },
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User .agents skills" },
  ], { seen: seenSkills }));
  const seenMcp = new Set<string>();
  items.push(...adeMcpItems(ctx, preview?.mcpServers ?? [], seenMcp));
  items.push(...await mcpItems(ctx, [
    { file: path.join(ctx.cwd, ".kimi-code", "mcp.json"), format: "json", key: "mcpServers", scope: "project" },
    { file: path.join(ctx.cwd, ".mcp.json"), format: "json", key: "mcpServers", scope: "project" },
    { file: path.join(home, "mcp.json"), format: "json", key: "mcpServers", scope: "user" },
  ], { seen: seenMcp }));
  return { items, adeSkillsNative: false };
}

/** Grok, Devin, Antigravity: only the MCP servers their own config files name. */
async function basicMcpItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const seenMcp = new Set<string>();
  const items = adeMcpItems(ctx, preview?.mcpServers ?? [], seenMcp);
  const xdg = ctx.env.XDG_CONFIG_HOME?.trim() || path.join(ctx.home, ".config");
  const sources: McpSource[] = [];
  switch (ctx.provider) {
    case "grok":
      sources.push(
        { file: path.join(ctx.cwd, ".grok", "config.toml"), format: "toml", scope: "project" },
        { file: path.join(grokConfigHome(homeEnv(ctx)), "config.toml"), format: "toml", scope: "user" },
      );
      break;
    case "devin": {
      const userDir = process.platform === "win32"
        ? path.join(ctx.env.APPDATA?.trim() || path.join(ctx.home, "AppData", "Roaming"), "devin")
        : path.join(xdg, "devin");
      for (const [dir, scope] of [[path.join(ctx.cwd, ".devin"), "project"], [userDir, "user"]] as const) {
        for (const file of ["mcp_config.json", "mcp_config.local.json", "config.json", "config.local.json"]) {
          sources.push({ file: path.join(dir, file), format: "json", key: "mcpServers", scope });
        }
      }
      break;
    }
    case "antigravity":
      sources.push(
        { file: path.join(ctx.cwd, ".agents", "mcp_config.json"), format: "json", key: "mcpServers", scope: "project" },
        { file: path.join(ctx.home, ".gemini", "config", "mcp_config.json"), format: "json", key: "mcpServers", scope: "user" },
      );
      break;
    default:
      break;
  }
  items.push(...await mcpItems(ctx, sources, { seen: seenMcp }));
  return { items, adeSkillsNative: false };
}

// ---------------------------------------------------------------------------
// ADE's own items
// ---------------------------------------------------------------------------

function adeItems(ctx: Ctx, preview: AdeChatContextPreview): ProviderContextItem[] {
  const byId = new Map(preview.parts.map((part) => [part.id, part]));
  const toItem = (part: AdeChatContextPart, tokens: number, label = part.label, detail = part.detail ?? null): ProviderContextItem => ({
    id: part.id,
    owner: "ade",
    kind: part.kind,
    label,
    source: part.source ?? null,
    ...(part.id === "ade-project-notes" ? { setIn: "ADE Settings › Agent notes", settingsEntry: "project-agents.agent-notes" } : {}),
    tokens,
    sizeKind: "exact",
    timing: part.timing,
    detail,
    ...(part.entries?.length
      ? {
          children: part.entries.map((entry, index) => ({
            id: `${part.id}-${index}`,
            owner: "ade" as const,
            kind: "skill" as const,
            label: entry.name,
            ...(entry.source ? located(ctx, entry.source) : { source: null }),
            tokens: estimateTextTokens(entry.text),
            sizeKind: "exact" as const,
            timing: part.timing,
          })),
        }
      : {}),
  });
  const items: ProviderContextItem[] = [];
  for (const part of preview.parts) {
    if (part.id === "ade-prompt") {
      const inner = (part.includes ?? []).map((id) => byId.get(id)).filter((entry): entry is AdeChatContextPart => Boolean(entry));
      const rest = Math.max(0, estimateTextTokens(part.text) - inner.reduce((total, entry) => total + estimateTextTokens(entry.text), 0));
      // ACP guidance is just the CLI guidance and notes; nothing of its own is left.
      if (rest < 20 && inner.length) continue;
      items.push(toItem(part, rest, inner.length ? `${part.label} (the rest)` : part.label,
        inner.length ? `${part.detail ?? ""} The parts listed beside it are counted on their own.`.trim() : part.detail ?? null));
      continue;
    }
    items.push(toItem(part, estimateTextTokens(part.text)));
  }
  return items;
}

/** ADE's skill catalogue, for the providers ADE hands its skill roots to as native skills. */
async function adeSkillCatalog(ctx: Ctx, roots: readonly string[], seen: Set<string>): Promise<ProviderContextItem[]> {
  const items = await skillItems(ctx, roots.map((dir) => ({ dir, label: "ADE skills", owner: "ade" as const })), {
    seen,
    detail: "ADE's bundled skills, handed to the provider as its own; names and descriptions are listed.",
  });
  return items;
}

// ---------------------------------------------------------------------------
// Measured
// ---------------------------------------------------------------------------

/** Fewer chats than this give no figure: one odd chat would be the whole answer. */
const MIN_MEASURE_SAMPLES = 3;

/**
 * The median size of a chat's first request, from first turns that made one
 * request. A first turn that called tools reports its last request, which
 * holds the tool results too (a Claude chat in ADE's repo: 58k for one request,
 * 117k with tools), so those turns say nothing about what a chat starts with.
 * This project's chats come first, because its instruction files are part of
 * the figure; with too few of them, the machine's chats answer.
 */
export function medianFirstTurnContext(
  rows: readonly AdeTurnUsageRecord[],
  provider: string,
  sinceMs: number,
  projectRoot: string | null = null,
): ProviderContextMeasurement | null {
  const first = new Map<string, AdeTurnUsageRecord>();
  const startedMs = (row: AdeTurnUsageRecord) => Date.parse(row.startedAt ?? row.at);
  for (const row of rows) {
    if (row.provider !== provider || row.surface === "personal") continue;
    const existing = first.get(row.sessionId);
    if (!existing || startedMs(row) < startedMs(existing)) first.set(row.sessionId, row);
  }
  const samples = [...first.values()]
    // A session whose earliest row is older than the window started before it,
    // so that row is not its first turn.
    .filter((row) => startedMs(row) >= sinceMs
      && typeof row.contextTokens === "number" && row.contextTokens > 0
      && row.requestCount === 1);
  const root = projectRoot ? path.resolve(projectRoot) : null;
  const inProject = root ? samples.filter((row) => row.projectRoot && path.resolve(row.projectRoot) === root) : [];
  const [chosen, scope] = inProject.length >= MIN_MEASURE_SAMPLES
    ? [inProject, "project" as const]
    : [samples, "machine" as const];
  if (chosen.length < MIN_MEASURE_SAMPLES) return null;
  const values = chosen.map((row) => row.contextTokens as number).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle]! : Math.round((values[middle - 1]! + values[middle]!) / 2);
  const oldest = chosen.reduce((min, row) => Math.min(min, startedMs(row)), Number.POSITIVE_INFINITY);
  return { firstTurnTokens: median, sampleCount: chosen.length, since: new Date(oldest).toISOString(), scope };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseGetProviderContextInventoryArgs(value: unknown): GetProviderContextInventoryArgs {
  const record = isRecord(value) ? value : {};
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  if (!(PROVIDER_CONTEXT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`getProviderContextInventory needs a provider: one of ${PROVIDER_CONTEXT_PROVIDERS.join(", ")}.`);
  }
  const laneId = typeof record.laneId === "string" && record.laneId.trim() ? record.laneId.trim() : null;
  return { provider, laneId };
}

export async function getProviderContextInventory(
  deps: ProviderContextInventoryDeps,
  args: GetProviderContextInventoryArgs,
): Promise<ProviderContextInventory> {
  const { provider } = parseGetProviderContextInventoryArgs(args);
  const nowMs = deps.nowMs?.() ?? Date.now();
  const logger = deps.logger ?? null;

  let preview: AdeChatContextPreview | null = null;
  const previewFn = deps.agentChatService?.previewNewChatAdeContext;
  if (typeof previewFn === "function") {
    try {
      preview = await previewFn({ provider, laneId: args.laneId ?? null });
    } catch (error) {
      logger?.warn("provider_context.ade_preview_failed", { provider, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const home = path.resolve(deps.homeDir ?? os.homedir());
  const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env), ...(preview?.providerHomeEnv ?? {}) };
  const cwd = path.resolve(preview?.laneWorktreePath ?? deps.projectRoot);
  let counter = 0;
  const base = { logger };
  const gitRoot = await findGitRoot(cwd);
  const ctx: Ctx = {
    provider,
    env,
    home,
    cwd,
    gitRoot,
    mainRoot: await findMainRoot(base, gitRoot),
    logger,
    nextId: (prefix) => `${prefix}-${(counter += 1)}`,
  };

  const discovered: ProviderItems = await (async () => {
    try {
      switch (provider) {
        case "claude": return await claudeItems(ctx, preview);
        case "codex": return await codexItems(ctx, preview);
        case "copilot": return await copilotItems(ctx, preview);
        case "cursor": return await cursorItems(ctx, preview);
        case "opencode": return await openCodeItems(ctx, preview);
        case "pi": return await piItems(ctx);
        case "droid": return await droidItems(ctx, preview);
        case "qwen": return await qwenItems(ctx, preview);
        case "kimi": return await kimiItems(ctx, preview);
        case "grok":
        case "devin":
        case "antigravity": return await basicMcpItems(ctx, preview);
        default: return { items: adeMcpItems(ctx, preview?.mcpServers ?? [], new Set()), adeSkillsNative: false };
      }
    } catch (error) {
      logger?.warn("provider_context.discovery_failed", { provider, error: error instanceof Error ? error.message : String(error) });
      return { items: [], adeSkillsNative: false };
    }
  })();

  const items: ProviderContextItem[] = [];
  if (preview) items.push(...adeItems(ctx, preview));
  if (preview && discovered.adeSkillsNative) {
    // ADE's own skill roots, ahead of the user's: a same-named user skill is a
    // different skill, but listing ADE's first matches the catalogue order.
    items.push(...await adeSkillCatalog(ctx, preview.adeSkillRoots, new Set()));
  }
  items.push(...discovered.items);

  let measured: ProviderContextMeasurement | null = null;
  try {
    const sinceMs = nowMs - MEASURE_WINDOW_DAYS * DAY_MS;
    // A little earlier than the window, so a session that began just before it
    // is seen as older and left out rather than counted from a later turn.
    const readTurns = deps.readTurns
      ?? ((since: number) => getSharedTurnUsageLedger(resolveMachineAdeDir(), logger).store.readTurns({ sinceMs: since }));
    measured = medianFirstTurnContext(await readTurns(sinceMs - 7 * DAY_MS), provider, sinceMs, deps.projectRoot);
  } catch (error) {
    logger?.warn("provider_context.measure_failed", { provider, error: error instanceof Error ? error.message : String(error) });
  }

  const known = items.reduce((total, entry) => total + (entry.timing === "on-demand" ? 0 : entry.tokens ?? 0), 0);
  const providerName = PROVIDER_NAMES[provider] ?? provider;
  items.unshift({
    id: "harness",
    owner: "harness",
    kind: "system-prompt",
    label: `${providerName}'s own prompt and tools`,
    source: null,
    tokens: measured ? Math.max(0, measured.firstTurnTokens - known) : null,
    sizeKind: measured ? "measured" : "unknown",
    timing: "every-request",
    detail: measured
      ? measured.firstTurnTokens > known
        ? `The rest of the measured first request: ${providerName}'s own prompt, its tool definitions, MCP tools and your first message.`
        : `The items above add up to more than the measured first request, so nothing is left to show for ${providerName}'s own prompt and tools.`
      : `${providerName} does not report its own prompt and tools before a chat starts; their size shows here after a few chats.`,
  });

  return {
    provider,
    generatedAt: new Date(nowMs).toISOString(),
    cwd: displayPath(home, cwd),
    laneId: preview?.laneId ?? args.laneId ?? null,
    coverage: (GOOD_COVERAGE.has(provider) ? "good" : "basic") satisfies ProviderContextCoverage,
    coverageNote: COVERAGE_NOTES[provider] ?? "Only ADE's own text is listed for this provider.",
    items,
    measured,
  };
}
