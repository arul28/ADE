import fs from "node:fs";
import path from "node:path";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { writeTextAtomic } from "../shared/utils";
import type {
  createUnifiedMemoryService,
  Memory,
  MemoryCategory,
  MemoryImportance,
} from "./unifiedMemoryService";

type TopicKey =
  | "decisions"
  | "conventions"
  | "preferences"
  | "gotchas"
  | "patterns"
  | "procedures"
  | "facts";

type TopicDefinition = {
  key: TopicKey;
  title: string;
  fileName: string;
  categories: MemoryCategory[];
  description: string;
  promptHint: RegExp;
};

type PromptContextResult = {
  text: string;
  bootstrapLoaded: boolean;
  topicFilesLoaded: string[];
};

export type ProjectMemoryFilesService = {
  sync: () => void;
  readBootstrapIndex: (opts?: { maxLines?: number; maxChars?: number }) => string;
  buildPromptContext: (opts: {
    promptText: string;
    maxBootstrapLines?: number;
    maxTopicFiles?: number;
    maxTopicLines?: number;
    maxChars?: number;
  }) => PromptContextResult;
};

const TOPICS: TopicDefinition[] = [
  {
    key: "decisions",
    title: "Decisions",
    fileName: "decisions.md",
    categories: ["decision"],
    description: "Durable architecture choices and tradeoffs.",
    promptHint: /\b(?:decision|trade(?:-| )?off|architecture|architectural|why did|why do|choose|chose|chosen|approach)\b/i,
  },
  {
    key: "conventions",
    title: "Conventions",
    fileName: "conventions.md",
    categories: ["convention"],
    description: "Repo rules, naming, and team habits that should be followed by default.",
    promptHint: /\b(?:convention|standard|style|naming|format|folder|structure|organization|repo|repository|workspace)\b/i,
  },
  {
    key: "preferences",
    title: "Preferences",
    fileName: "preferences.md",
    categories: ["preference"],
    description: "Durable user and project preferences worth carrying across sessions.",
    promptHint: /\b(?:prefer|preference|tone|format|respond|response|brief|concise|verbose|always|never)\b/i,
  },
  {
    key: "gotchas",
    title: "Gotchas",
    fileName: "gotchas.md",
    categories: ["gotcha"],
    description: "Known pitfalls, failure modes, and sharp edges.",
    promptHint: /\b(?:gotcha|pitfall|sharp edge|bug|error|failing|failure|breaks?|broken|regression|issue|trap)\b/i,
  },
  {
    key: "patterns",
    title: "Patterns",
    fileName: "patterns.md",
    categories: ["pattern"],
    description: "Reusable implementation patterns and shared solutions.",
    promptHint: /\b(?:pattern|patterns|shared approach|integration|api|flow|state|component|service|hook)\b/i,
  },
  {
    key: "procedures",
    title: "Procedures",
    fileName: "procedures.md",
    categories: ["procedure"],
    description: "Repeatable workflows, validation steps, and operational runbooks.",
    promptHint: /\b(?:procedure|workflow|steps?|checklist|runbook|playbook|validate|verification|test|build|lint|typecheck|release|deploy)\b/i,
  },
  {
    key: "facts",
    title: "Facts",
    fileName: "facts.md",
    categories: ["fact"],
    description: "Stable project facts and context that are hard to infer quickly from code alone.",
    promptHint: /\b(?:fact|context|background|overview|system|module|domain|product)\b/i,
  },
];

const PROMOTED_TOPIC_CATEGORIES = TOPICS.flatMap((topic) => topic.categories);
const PLACEHOLDER_LINE = "- No promoted project memories yet. Use ADE memory tools to capture durable project knowledge.";

function clipText(value: string, maxChars = 220): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function memoryImportanceRank(value: MemoryImportance): number {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function sortMemories(left: Memory, right: Memory): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (left.tier !== right.tier) return left.tier - right.tier;
  const importanceDelta = memoryImportanceRank(right.importance) - memoryImportanceRank(left.importance);
  if (importanceDelta !== 0) return importanceDelta;
  if (right.confidence !== left.confidence) return right.confidence - left.confidence;
  return String(right.updatedAt).localeCompare(String(left.updatedAt));
}

function readBoundedText(filePath: string, opts?: { maxLines?: number; maxChars?: number }): string {
  if (!fs.existsSync(filePath)) return "";
  const maxLines = Math.max(1, Math.min(200, Math.floor(opts?.maxLines ?? 200)));
  const maxChars = Math.max(200, Math.min(8_000, Math.floor(opts?.maxChars ?? 2_400)));
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).slice(0, maxLines);
  const joined = lines.join("\n").trim();
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars).trimEnd();
}

function hasMeaningfulMemoryContent(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.includes(PLACEHOLDER_LINE);
}

function buildTopicHeader(topic: TopicDefinition): string[] {
  return [
    `# ${topic.title}`,
    "",
    "Internal ADE-generated project memory topic file. The source of truth is ADE's promoted project memory store; manual edits here may be overwritten.",
    "",
    "## When to load",
    `- ${topic.description}`,
    "",
  ];
}

function labelForMemory(memory: Memory): string {
  const details = [
    `category=${memory.category}`,
    `tier=${memory.tier}`,
    memory.pinned ? "pinned=yes" : null,
    `importance=${memory.importance}`,
    `confidence=${memory.confidence.toFixed(2)}`,
    memory.fileScopePattern ? `path=${memory.fileScopePattern}` : null,
    memory.sourceType ? `source=${memory.sourceType}` : null,
  ].filter((part): part is string => Boolean(part));
  return details.join(" | ");
}

export function createProjectMemoryFilesService(args: {
  projectRoot: string;
  projectId: string;
  memoryService: Pick<ReturnType<typeof createUnifiedMemoryService>, "listMemories">;
}): ProjectMemoryFilesService {
  const layout = resolveAdeLayout(args.projectRoot);
  const memoryDir = layout.memoryDir;
  const indexPath = path.join(memoryDir, "MEMORY.md");
  const topicPaths = Object.fromEntries(
    TOPICS.map((topic) => [topic.key, path.join(memoryDir, topic.fileName)]),
  ) as Record<TopicKey, string>;

  const listPromotedProjectMemories = (): Memory[] => {
    const seen = new Set<string>();
    return args.memoryService
      .listMemories({
        projectId: args.projectId,
        scope: "project",
        status: "promoted",
        categories: PROMOTED_TOPIC_CATEGORIES,
        limit: 400,
      })
      .filter((memory) => {
        if (seen.has(memory.id)) return false;
        seen.add(memory.id);
        return true;
      })
      .sort(sortMemories);
  };

  const renderTopicFile = (topic: TopicDefinition, entries: Memory[]): string => {
    const lines = buildTopicHeader(topic);
    if (entries.length === 0) {
      lines.push("## Entries");
      lines.push(PLACEHOLDER_LINE);
      return `${lines.join("\n").trim()}\n`;
    }

    lines.push("## Entries");
    for (const [index, memory] of entries.entries()) {
      lines.push(`### ${index + 1}. ${clipText(memory.content, 96)}`);
      lines.push(`- ${labelForMemory(memory)}`);
      lines.push(`- updated=${memory.updatedAt}`);
      lines.push(`- content=${clipText(memory.content, 420)}`);
      lines.push("");
    }
    while (lines[lines.length - 1] === "") lines.pop();
    return `${lines.join("\n").trim()}\n`;
  };

  const renderIndexFile = (memories: Memory[], grouped: Map<TopicKey, Memory[]>): string => {
    const pinned = memories.filter((memory) => memory.pinned).slice(0, 6);
    const highSignal = memories.slice(0, 12);
    const lines: string[] = [
      "# ADE Auto Memory",
      "",
      "Internal ADE-generated project memory bootstrap. ADE writes this from promoted project memory so sessions can load a compact, Claude-style memory index before deeper retrieval.",
      "",
      "## How to use this file",
      "- Read this file first for repo-wide habits, decisions, and pitfalls.",
      "- Open the listed topic files when the current task clearly touches that area.",
      "- Current source files, tests, configs, and user instructions win if they disagree.",
      "",
      "## Topic files",
      ...TOPICS.map((topic) => {
        const count = grouped.get(topic.key)?.length ?? 0;
        return `- ${topic.fileName} (${count}): ${topic.description}`;
      }),
      "",
    ];

    lines.push("## Pinned highlights");
    if (pinned.length === 0) {
      lines.push("- No pinned project memories yet.");
    } else {
      for (const memory of pinned) {
        lines.push(`- [${memory.category}] ${clipText(memory.content, 180)}`);
      }
    }
    lines.push("");

    lines.push("## Current high-signal memory");
    if (highSignal.length === 0) {
      lines.push(PLACEHOLDER_LINE);
    } else {
      for (const topic of TOPICS) {
        const entries = (grouped.get(topic.key) ?? []).slice(0, 2);
        if (entries.length === 0) continue;
        lines.push(`### ${topic.title}`);
        for (const memory of entries) {
          lines.push(`- ${clipText(memory.content, 180)}`);
        }
        lines.push("");
      }
      while (lines[lines.length - 1] === "") lines.pop();
    }

    lines.push("");
    lines.push(`Updated: ${new Date().toISOString()}`);
    return `${lines.join("\n").trim()}\n`;
  };

  const ensureFilesExist = (): void => {
    // Check all expected files, not just the index — topic files may be
    // partially absent if the memory dir was only partially present.
    if (
      fs.existsSync(indexPath) &&
      TOPICS.every((topic) => fs.existsSync(topicPaths[topic.key]))
    ) {
      return;
    }
    sync();
  };

  const sync = (): void => {
    const memories = listPromotedProjectMemories();
    const grouped = new Map<TopicKey, Memory[]>();
    for (const topic of TOPICS) {
      grouped.set(
        topic.key,
        memories.filter((memory) => topic.categories.includes(memory.category)),
      );
    }

    fs.mkdirSync(memoryDir, { recursive: true });
    writeTextAtomic(indexPath, renderIndexFile(memories, grouped));
    for (const topic of TOPICS) {
      writeTextAtomic(topicPaths[topic.key], renderTopicFile(topic, grouped.get(topic.key) ?? []));
    }
  };

  const readBootstrapIndex = (opts?: { maxLines?: number; maxChars?: number }): string => {
    ensureFilesExist();
    const text = readBoundedText(indexPath, opts);
    return hasMeaningfulMemoryContent(text) ? text : "";
  };

  const buildPromptContext = (opts: {
    promptText: string;
    maxBootstrapLines?: number;
    maxTopicFiles?: number;
    maxTopicLines?: number;
    maxChars?: number;
  }): PromptContextResult => {
    ensureFilesExist();
    const maxChars = Math.max(400, Math.min(6_000, Math.floor(opts.maxChars ?? 2_400)));
    const sections: string[] = [];
    const bootstrap = readBootstrapIndex({
      maxLines: opts.maxBootstrapLines ?? 80,
      maxChars,
    });

    if (bootstrap.length > 0) {
      sections.push([
        "ADE auto memory bootstrap (generated from promoted project memory):",
        bootstrap,
      ].join("\n"));
    }

    const promptText = String(opts.promptText ?? "");
    const matchingTopics = TOPICS
      .filter((topic) => topic.promptHint.test(promptText))
      .slice(0, Math.max(0, Math.min(3, Math.floor(opts.maxTopicFiles ?? 2))));

    const loadedTopics: string[] = [];
    for (const topic of matchingTopics) {
      const topicText = readBoundedText(topicPaths[topic.key], {
        maxLines: opts.maxTopicLines ?? 18,
        maxChars: Math.max(200, Math.floor(maxChars / 2)),
      });
      if (!hasMeaningfulMemoryContent(topicText)) continue;
      loadedTopics.push(topic.fileName);
      sections.push([
        `Relevant ADE auto memory topic (${topic.fileName}):`,
        topicText,
      ].join("\n"));
    }

    let text = sections.filter((section) => section.trim().length > 0).join("\n\n").trim();
    if (text.length > maxChars) {
      text = text.slice(0, maxChars).trimEnd();
    }

    // Only report topics that actually survived the final maxChars truncation.
    // If trailing topic sections were clipped away, they should not appear in loadedTopics.
    const survivingTopics = loadedTopics.filter((fileName) => text.includes(fileName));

    return {
      text,
      bootstrapLoaded: bootstrap.length > 0,
      topicFilesLoaded: survivingTopics,
    };
  };

  return {
    sync,
    readBootstrapIndex,
    buildPromptContext,
  };
}
