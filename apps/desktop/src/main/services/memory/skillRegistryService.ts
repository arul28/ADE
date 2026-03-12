import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { SkillIndexEntry, SkillIndexKind, SkillIndexSource } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { nowIso } from "../shared/utils";
import type { UnifiedMemoryService } from "./unifiedMemoryService";
import type { ProceduralLearningService } from "./proceduralLearningService";

type SkillIndexRow = {
  id: string;
  path: string;
  kind: SkillIndexKind;
  source: SkillIndexSource;
  memory_id: string | null;
  content_hash: string;
  last_modified_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

const WATCH_PATTERNS = [
  ".ade/skills/**/*.md",
  ".claude/skills/**/*.md",
  ".claude/commands/**/*.md",
  "CLAUDE.md",
  "agents.md",
];

function normalizeFileContent(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "skill";
}

function inferKind(filePath: string): SkillIndexKind {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.endsWith("/CLAUDE.md") || normalized.endsWith("/agents.md")) return "root_doc";
  if (normalized.includes("/.claude/commands/")) return "command";
  return "skill";
}

function buildProcedureBody(title: string, content: string, sourcePath?: string): string {
  return [
    `Imported skill: ${title}`,
    ...(sourcePath ? [`Source path: ${sourcePath}`, ""] : [""]),
    content,
  ].join("\n").trim();
}

function normalizeProcedureText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^imported skill:\s+.*$/gm, "")
    .replace(/^source path:\s+.*$/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ");
}

function procedureSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeProcedureText(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeProcedureText(right).split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  const union = leftTokens.size + rightTokens.size - overlap;
  return union > 0 ? overlap / union : 0;
}

function proceduresMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeProcedureText(left);
  const normalizedRight = normalizeProcedureText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft)
    || procedureSimilarity(normalizedLeft, normalizedRight) >= 0.72
  );
}

function extractMarkdownSection(markdown: string, heading: string): string[] {
  const lines = normalizeFileContent(markdown).split("\n");
  const targetHeading = `## ${heading}`.toLowerCase();
  const collected: string[] = [];
  let active = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === targetHeading) {
      active = true;
      continue;
    }
    if (active && /^##\s+/i.test(trimmed)) break;
    if (active) collected.push(line);
  }
  return collected
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function buildSkillMarkdown(input: {
  title: string;
  procedureId: string;
  trigger: string;
  procedureMarkdown: string;
}): string {
  const recommendedSteps = extractMarkdownSection(input.procedureMarkdown, "Recommended Procedure")
    .map((line) => line.replace(/^\d+\.\s*/, "").trim())
    .filter((line) => line.length > 0);
  const usefulTools = extractMarkdownSection(input.procedureMarkdown, "Useful Tools");
  const keyDecisions = extractMarkdownSection(input.procedureMarkdown, "Key Decisions");
  const patterns = extractMarkdownSection(input.procedureMarkdown, "Patterns");
  const watchOuts = extractMarkdownSection(input.procedureMarkdown, "Watch Outs");

  const contextLines = [
    ...patterns.map((line) => `- Pattern: ${line.replace(/^[-*]\s*/, "")}`),
    ...watchOuts.map((line) => `- Watch out: ${line.replace(/^[-*]\s*/, "")}`),
    ...keyDecisions.map((line) => `- Decision: ${line.replace(/^[-*]\s*/, "")}`),
    ...usefulTools.map((line) => `- Tool: ${line.replace(/^[-*]\s*/, "")}`),
  ];

  const lines = [
    `# ${input.title}`,
    "",
    "## When to use",
    `Use this when ${input.trigger.trim() || "the workflow applies"}.`,
    "",
    "## Steps",
    ...(recommendedSteps.length > 0
      ? recommendedSteps.map((step, index) => `${index + 1}. ${step}`)
      : ["1. Follow the source procedure below and adapt it to the current task."]),
    "",
    "## Context",
    `- Source procedure memory: ${input.procedureId}`,
    ...(contextLines.length > 0 ? contextLines : ["- No extra context has been captured yet."]),
  ];

  return lines.join("\n").trim();
}

export function createSkillRegistryService(args: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  logger?: Pick<Logger, "warn"> | null;
  memoryService: Pick<
    UnifiedMemoryService,
    "getMemory" | "listMemories" | "addMemory" | "writeMemory" | "archiveMemory"
  >;
  proceduralLearningService?: Pick<
    ProceduralLearningService,
    "markExportedSkill" | "getProcedureDetail" | "markProcedureSuperseded"
  > | null;
}) {
  const { db, projectId, projectRoot, memoryService } = args;
  let watcher: FSWatcher | null = null;

  const readSkillIndexByPath = (absolutePath: string): SkillIndexRow | null => {
    return db.get<SkillIndexRow>(
      `select * from memory_skill_index where path = ? limit 1`,
      [absolutePath],
    ) ?? null;
  };

  const listIndexedSkills = (): SkillIndexEntry[] => {
    const rows = db.all<SkillIndexRow>(
      `
        select *
        from memory_skill_index
        order by archived_at is not null, updated_at desc, path asc
      `,
    );
    return rows.map((row) => {
      return {
        id: row.id,
        path: row.path,
        kind: row.kind,
        source: row.source,
        memoryId: row.memory_id,
        contentHash: row.content_hash,
        lastModifiedAt: row.last_modified_at,
        archivedAt: row.archived_at,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
      };
    });
  };

  const upsertSkillIndex = (input: {
    absolutePath: string;
    contentHash: string;
    kind: SkillIndexKind;
    source: SkillIndexSource;
    memoryId: string | null;
    lastModifiedAt: string | null;
    archivedAt?: string | null;
  }): void => {
    const existing = readSkillIndexByPath(input.absolutePath);
    const now = nowIso();
    db.run(
      `
        insert into memory_skill_index(
          id, path, kind, source, memory_id, content_hash,
          last_modified_at, archived_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(path) do update set
          kind = excluded.kind,
          source = excluded.source,
          memory_id = excluded.memory_id,
          content_hash = excluded.content_hash,
          last_modified_at = excluded.last_modified_at,
          archived_at = excluded.archived_at,
          updated_at = excluded.updated_at
      `,
      [
        existing?.id ?? randomUUID(),
        input.absolutePath,
        input.kind,
        input.source,
        input.memoryId,
        input.contentHash,
        input.lastModifiedAt,
        input.archivedAt ?? null,
        existing?.created_at ?? now,
        now,
      ],
    );
  };

  const indexFile = (absolutePath: string, source: SkillIndexSource = "user"): SkillIndexEntry | null => {
    if (!fs.existsSync(absolutePath)) {
      const existing = readSkillIndexByPath(absolutePath);
      if (existing?.memory_id) {
        memoryService.archiveMemory(existing.memory_id);
      }
      upsertSkillIndex({
        absolutePath,
        contentHash: existing?.content_hash ?? "",
        kind: existing?.kind ?? inferKind(absolutePath),
        source,
        memoryId: existing?.memory_id ?? null,
        lastModifiedAt: existing?.last_modified_at ?? null,
        archivedAt: nowIso(),
      });
      return listIndexedSkills().find((entry) => entry.path === absolutePath) ?? null;
    }

    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return null;

    const content = normalizeFileContent(fs.readFileSync(absolutePath, "utf8"));
    const contentHash = hashContent(content);
    const title = path.basename(absolutePath).replace(/\.md$/i, "");
    const kind = inferKind(absolutePath);
    const existing = readSkillIndexByPath(absolutePath);
    const existingMemory = existing?.memory_id ? memoryService.getMemory(existing.memory_id) : null;
    const importedProcedureContent = buildProcedureBody(title, content, absolutePath);
    let memoryId = existing?.memory_id ?? null;

    if (!existingMemory) {
      const imported = memoryService.addMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: importedProcedureContent,
        importance: "high",
        sourceType: "user",
        sourceId: absolutePath,
      });
      memoryId = imported.id;
    } else {
      memoryService.writeMemory({
        projectId: existingMemory.projectId,
        scope: existingMemory.scope,
        scopeOwnerId: existingMemory.scopeOwnerId ?? undefined,
        tier: existingMemory.tier,
        category: existingMemory.category,
        content: importedProcedureContent,
        importance: existingMemory.importance,
        confidence: 1,
        status: "promoted",
        pinned: true,
        sourceSessionId: existingMemory.sourceSessionId ?? undefined,
        sourcePackKey: existingMemory.sourcePackKey ?? undefined,
        agentId: existingMemory.agentId ?? undefined,
        sourceRunId: existingMemory.sourceRunId ?? undefined,
        sourceType: "user",
        sourceId: absolutePath,
        fileScopePattern: existingMemory.fileScopePattern ?? undefined,
      });
      memoryId = existingMemory.id;
    }

    const duplicateSystemProcedure = memoryService.listMemories({
      projectId,
      scope: "project",
      categories: ["procedure"],
      limit: 500,
    }).find((memory) => {
      if (memory.id === memoryId) return false;
      if (memory.sourceType !== "system") return false;
      return proceduresMatch(memory.content, importedProcedureContent);
    });
    if (memoryId && duplicateSystemProcedure) {
      args.proceduralLearningService?.markProcedureSuperseded?.({
        memoryId: duplicateSystemProcedure.id,
        supersededByMemoryId: memoryId,
      });
    }

    upsertSkillIndex({
      absolutePath,
      contentHash,
      kind,
      source,
      memoryId,
      lastModifiedAt: stat.mtime.toISOString(),
      archivedAt: null,
    });
    return listIndexedSkills().find((entry) => entry.path === absolutePath) ?? null;
  };

  const expandPaths = (paths?: string[]): string[] => {
    if (paths && paths.length > 0) {
      return paths.map((entry) => (path.isAbsolute(entry) ? entry : path.join(projectRoot, entry))).map((entry) => path.resolve(entry));
    }
    const discovered = new Set<string>();
    const crawl = (currentPath: string) => {
      if (!fs.existsSync(currentPath)) return;
      const stat = fs.statSync(currentPath);
      if (stat.isFile() && currentPath.endsWith(".md")) {
        discovered.add(path.resolve(currentPath));
        return;
      }
      if (!stat.isDirectory()) return;
      for (const child of fs.readdirSync(currentPath)) {
        crawl(path.join(currentPath, child));
      }
    };
    crawl(path.join(projectRoot, ".ade", "skills"));
    crawl(path.join(projectRoot, ".claude", "skills"));
    crawl(path.join(projectRoot, ".claude", "commands"));
    for (const fileName of ["CLAUDE.md", "agents.md"]) {
      const absolute = path.join(projectRoot, fileName);
      if (fs.existsSync(absolute)) discovered.add(path.resolve(absolute));
    }
    return [...discovered];
  };

  const reindexSkills = async (input: { paths?: string[] } = {}): Promise<SkillIndexEntry[]> => {
    const indexed: SkillIndexEntry[] = [];
    for (const filePath of expandPaths(input.paths)) {
      const entry = indexFile(filePath);
      if (entry) indexed.push(entry);
    }
    return indexed;
  };

  const exportProcedureSkill = async (input: { id: string; name?: string | null }): Promise<{ path: string; skill: SkillIndexEntry | null } | null> => {
    const procedure = args.proceduralLearningService?.getProcedureDetail(input.id);
    if (!procedure) return null;
    const procedureTrigger = procedure.procedural.trigger.trim() || "skill";
    const title = String(input.name ?? procedureTrigger).trim() || procedureTrigger;
    const slugBase = slugify(title);
    let slug = slugBase;
    let counter = 2;
    let destinationDir = path.join(projectRoot, ".ade", "skills", slug);
    let destinationPath = path.join(destinationDir, "SKILL.md");
    while (fs.existsSync(destinationPath)) {
      slug = `${slugBase}-${counter}`;
      counter += 1;
      destinationDir = path.join(projectRoot, ".claude", "skills", slug);
      destinationPath = path.join(destinationDir, "SKILL.md");
    }
    fs.mkdirSync(destinationDir, { recursive: true });
    const markdown = buildSkillMarkdown({
      title,
      procedureId: procedure.memory.id,
      trigger: procedure.procedural.trigger,
      procedureMarkdown: procedure.procedural.procedure,
    });
    fs.writeFileSync(destinationPath, markdown, "utf8");
    const skill = indexFile(destinationPath, "exported");
    args.proceduralLearningService?.markExportedSkill(input.id, destinationPath);
    return { path: destinationPath, skill };
  };

  const start = async (): Promise<void> => {
    await reindexSkills();
    if (watcher) return;
    watcher = chokidar.watch(WATCH_PATTERNS, {
      cwd: projectRoot,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 120,
        pollInterval: 50,
      },
    });
    const reindexOne = (relativePath: string) => {
      const absolutePath = path.resolve(projectRoot, relativePath);
      try {
        indexFile(absolutePath);
      } catch (error) {
        args.logger?.warn?.("memory.skill_registry_reindex_failed", {
          path: absolutePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    watcher.on("add", reindexOne);
    watcher.on("change", reindexOne);
    watcher.on("unlink", reindexOne);
  };

  const dispose = async (): Promise<void> => {
    const current = watcher;
    watcher = null;
    await current?.close();
  };

  return {
    start,
    dispose,
    listIndexedSkills,
    reindexSkills,
    exportProcedureSkill,
  };
}

export type SkillRegistryService = ReturnType<typeof createSkillRegistryService>;
