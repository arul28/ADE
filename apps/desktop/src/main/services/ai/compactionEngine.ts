// ---------------------------------------------------------------------------
// Compaction Engine — context compaction, transcript persistence, session resume
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { streamText } from "ai";
import {
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import type { AdeDb } from "../state/kvDb";
import { resolveModel } from "./providerResolver";
import { detectAllAuth } from "./authDetector";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranscriptEntry = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
  tokenEstimate?: number;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
};

export type TranscriptRecord = {
  id: string;
  projectId: string;
  attemptId: string;
  runId: string;
  stepId: string;
  messagesJson: string;
  tokenCount: number;
  compactedAt: string | null;
  compactionSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompactionResult = {
  summary: string;
  factsExtracted: string[];
  previousTokenCount: number;
  newTokenCount: number;
};

export type CompactionMonitor = {
  totalTokens: number;
  contextWindow: number;
  threshold: number;
  shouldCompact: () => boolean;
  recordTokens: (inputTokens: number, outputTokens: number) => void;
};

// ---------------------------------------------------------------------------
// Transcript CRUD
// ---------------------------------------------------------------------------

export function appendTranscriptEntry(
  db: AdeDb,
  opts: {
    projectId: string;
    attemptId: string;
    runId: string;
    stepId: string;
    entry: TranscriptEntry;
  },
): void {
  const now = new Date().toISOString();
  const existing = db.get<Record<string, unknown>>(
    `SELECT id, messages_json, token_count FROM attempt_transcripts WHERE attempt_id = ? AND step_id = ?`,
    [opts.attemptId, opts.stepId],
  );

  if (existing) {
    let messages: TranscriptEntry[];
    try {
      messages = JSON.parse(String(existing.messages_json ?? "[]"));
    } catch {
      messages = [];
    }
    messages.push(opts.entry);
    const newTokenCount =
      Number(existing.token_count ?? 0) + (opts.entry.tokenEstimate ?? 0);
    db.run(
      `UPDATE attempt_transcripts SET messages_json = ?, token_count = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(messages), newTokenCount, now, String(existing.id)],
    );
  } else {
    const id = randomUUID();
    const messages = [opts.entry];
    db.run(
      `INSERT INTO attempt_transcripts (id, project_id, attempt_id, run_id, step_id, messages_json, token_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        opts.projectId,
        opts.attemptId,
        opts.runId,
        opts.stepId,
        JSON.stringify(messages),
        opts.entry.tokenEstimate ?? 0,
        now,
        now,
      ],
    );
  }
}

export function getTranscript(
  db: AdeDb,
  attemptId: string,
): { messagesJson: string; compactionSummary: string | null } | null {
  const row = db.get<Record<string, unknown>>(
    `SELECT messages_json, compaction_summary FROM attempt_transcripts WHERE attempt_id = ? ORDER BY updated_at DESC LIMIT 1`,
    [attemptId],
  );
  if (!row) return null;
  return {
    messagesJson: String(row.messages_json ?? "[]"),
    compactionSummary: row.compaction_summary
      ? String(row.compaction_summary)
      : null,
  };
}

export function getTranscriptRecord(
  db: AdeDb,
  attemptId: string,
): TranscriptRecord | null {
  const row = db.get<Record<string, unknown>>(
    `SELECT * FROM attempt_transcripts WHERE attempt_id = ? ORDER BY updated_at DESC LIMIT 1`,
    [attemptId],
  );
  if (!row) return null;
  return mapTranscriptRow(row);
}

export function markTranscriptCompacted(
  db: AdeDb,
  attemptId: string,
  summary: string,
  newMessagesJson: string,
  newTokenCount: number,
): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE attempt_transcripts
     SET compacted_at = ?, compaction_summary = ?, messages_json = ?, token_count = ?, updated_at = ?
     WHERE attempt_id = ?`,
    [now, summary, newMessagesJson, newTokenCount, now, attemptId],
  );
}

// ---------------------------------------------------------------------------
// Compaction Monitor — tracks token usage and triggers compaction
// ---------------------------------------------------------------------------

const DEFAULT_COMPACTION_RATIO = 0.7;

export function createCompactionMonitor(
  model: ModelDescriptor,
  ratio = DEFAULT_COMPACTION_RATIO,
): CompactionMonitor {
  const contextWindow = model.contextWindow;
  const threshold = Math.floor(contextWindow * ratio);
  let totalTokens = 0;

  return {
    get totalTokens() {
      return totalTokens;
    },
    contextWindow,
    threshold,
    shouldCompact() {
      return totalTokens >= threshold;
    },
    recordTokens(inputTokens: number, outputTokens: number) {
      totalTokens += (inputTokens || 0) + (outputTokens || 0);
    },
  };
}

// ---------------------------------------------------------------------------
// Compaction — summarize and compress conversation history
// ---------------------------------------------------------------------------

const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer for a software development AI agent.
Your job is to create a concise but complete summary of the conversation so far.

Rules:
- Preserve ALL important technical details: file paths, function names, error messages, architectural decisions
- Preserve the current task/goal and what has been accomplished so far
- Preserve any tool calls and their results that are still relevant
- Preserve any decisions made and their rationale
- Remove redundant back-and-forth, pleasantries, and exploratory dead ends
- Output a structured summary that the agent can use to continue its work seamlessly

Format your response as a structured summary with these sections:
## Current Task
## Progress So Far
## Key Decisions
## Important Context
## Next Steps`;

const FACT_EXTRACTION_PROMPT = `You are a fact extractor for a software development AI agent.
Analyze the conversation and extract important reusable facts that should be preserved across context compactions.

Extract facts about:
- API patterns discovered
- Schema or data structure details
- Configuration requirements
- Architectural decisions
- Common gotchas or edge cases found

Return ONLY a JSON array of strings, each being a concise fact. Return [] if no notable facts.
Example: ["The auth middleware requires X-Request-ID header", "PostgreSQL JSONB columns need explicit casting for array operations"]`;

export async function compactConversation(opts: {
  messages: TranscriptEntry[];
  modelId: string;
}): Promise<CompactionResult> {
  const { messages, modelId } = opts;

  const auth = await detectAllAuth();
  const sdkModel = await resolveModel(modelId, auth);

  // Estimate tokens for current messages
  const previousTokenCount = estimateTokens(messages);

  // Build a text representation of the conversation for summarization
  const conversationText = messages
    .map(
      (m) =>
        `[${m.role}${m.toolName ? ` (${m.toolName})` : ""}]: ${m.content}`,
    )
    .join("\n\n");

  // Summarize
  const summaryResult = streamText({
    model: sdkModel,
    system: COMPACTION_SYSTEM_PROMPT,
    prompt: `Summarize this conversation:\n\n${conversationText}`,
  });

  let summary = "";
  for await (const part of summaryResult.fullStream) {
    if (part.type === "text-delta") summary += part.text;
  }

  // Extract facts
  const factsResult = streamText({
    model: sdkModel,
    system: FACT_EXTRACTION_PROMPT,
    prompt: `Extract facts from this conversation:\n\n${conversationText}`,
  });

  let factsText = "";
  for await (const part of factsResult.fullStream) {
    if (part.type === "text-delta") factsText += part.text;
  }

  let factsExtracted: string[] = [];
  try {
    const parsed = JSON.parse(factsText.trim());
    if (Array.isArray(parsed)) {
      factsExtracted = parsed.filter(
        (f): f is string => typeof f === "string",
      );
    }
  } catch {
    // If fact extraction fails, continue without facts
  }

  const newTokenCount = estimateTokens([
    { role: "system", content: summary, timestamp: new Date().toISOString() },
  ]);

  return {
    summary,
    factsExtracted,
    previousTokenCount,
    newTokenCount,
  };
}

// ---------------------------------------------------------------------------
// Pre-compaction writeback — extract and save shared facts
// ---------------------------------------------------------------------------

export async function preCompactionWriteback(opts: {
  db: AdeDb;
  runId: string;
  stepId: string;
  facts: string[];
  addSharedFact: (opts: {
    runId: string;
    stepId?: string;
    factType: "api_pattern" | "schema_change" | "config" | "architectural" | "gotcha";
    content: string;
  }) => unknown;
}): Promise<void> {
  const { runId, stepId, facts, addSharedFact } = opts;

  for (const fact of facts) {
    const factType = classifyFact(fact);
    addSharedFact({
      runId,
      stepId,
      factType,
      content: fact,
    });
  }
}

function classifyFact(
  fact: string,
): "api_pattern" | "schema_change" | "config" | "architectural" | "gotcha" {
  const lower = fact.toLowerCase();
  if (
    lower.includes("api") ||
    lower.includes("endpoint") ||
    lower.includes("header") ||
    lower.includes("middleware")
  )
    return "api_pattern";
  if (
    lower.includes("schema") ||
    lower.includes("table") ||
    lower.includes("column") ||
    lower.includes("migration")
  )
    return "schema_change";
  if (
    lower.includes("config") ||
    lower.includes("env") ||
    lower.includes("setting") ||
    lower.includes("variable")
  )
    return "config";
  if (
    lower.includes("gotcha") ||
    lower.includes("edge case") ||
    lower.includes("workaround") ||
    lower.includes("bug")
  )
    return "gotcha";
  return "architectural";
}

// ---------------------------------------------------------------------------
// Token estimation (rough — 1 token ~= 4 chars)
// ---------------------------------------------------------------------------

function estimateTokens(messages: TranscriptEntry[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.tokenEstimate) {
      total += msg.tokenEstimate;
    } else {
      total += Math.ceil(msg.content.length / 4);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function mapTranscriptRow(row: Record<string, unknown>): TranscriptRecord {
  return {
    id: String(row.id ?? ""),
    projectId: String(row.project_id ?? ""),
    attemptId: String(row.attempt_id ?? ""),
    runId: String(row.run_id ?? ""),
    stepId: String(row.step_id ?? ""),
    messagesJson: String(row.messages_json ?? "[]"),
    tokenCount: Number(row.token_count ?? 0),
    compactedAt: row.compacted_at ? String(row.compacted_at) : null,
    compactionSummary: row.compaction_summary
      ? String(row.compaction_summary)
      : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}
