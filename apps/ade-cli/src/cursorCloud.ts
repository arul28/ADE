/**
 * Cursor Cloud subcommands for ade-cli.
 *
 * These commands talk to the Cursor SDK directly (no ADE socket / no headless
 * runtime). The two ADE entry points the desktop app exposes are:
 *
 *   1. "Send to Cursor Cloud" — fresh agent + prompt + repo + branch + model.
 *   2. "Open existing cloud chat" — mirror an existing cloud agent in ADE.
 *
 * Everything here exists so a CLI / agent can drive the same surface without
 * coupling to ADE main. There is no "bring to local" or fork-to-local flow:
 * cloud and local stay separate.
 */

import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CURSOR_WINDOWS_ARM_BLOCKER,
  isCursorProviderSupported,
} from "../../desktop/src/shared/providerPlatformSupport";

type CursorSdk = typeof import("@cursor/sdk");

const requireFromRuntime = createRequire(
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
);
let sdkModulePromise: Promise<CursorSdk> | null = null;

function cursorSdkLoadErrorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isCursorSdkResolutionError(error: unknown): boolean {
  const code = error && typeof error === "object"
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = cursorSdkLoadErrorText(error);
  return code === "ERR_MODULE_NOT_FOUND"
    || code === "MODULE_NOT_FOUND"
    || /Cannot find package ['"]@cursor\/sdk['"]/i.test(message)
    || /Cannot find module ['"]@cursor\/sdk['"]/i.test(message);
}

async function getSdk(): Promise<CursorSdk> {
  // @cursor/sdk publishes no win32-arm64 runtime, so this import can never
  // succeed on Windows on ARM. Fail with the reason instead of a bare
  // ERR_MODULE_NOT_FOUND. See desktop/src/shared/providerPlatformSupport.ts.
  if (!isCursorProviderSupported(process.platform, process.arch)) {
    throw new Error(CURSOR_WINDOWS_ARM_BLOCKER);
  }
  if (!sdkModulePromise) {
    sdkModulePromise = import("@cursor/sdk")
      .catch((error) => {
        if (!isCursorSdkResolutionError(error)) throw error;
        try {
          return requireFromRuntime("@cursor/sdk") as CursorSdk;
        } catch (fallbackError) {
          throw new Error(
            `Failed to load @cursor/sdk via dynamic import or packaged runtime resolution. import=${cursorSdkLoadErrorText(error)} require=${cursorSdkLoadErrorText(fallbackError)}`,
          );
        }
      })
      .catch((error) => {
        sdkModulePromise = null;
        throw error;
      });
  }
  return sdkModulePromise;
}

export class CursorCloudUsageError extends Error {}
export class CursorCloudExecutionError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

export type CursorOutputMode = "json" | "text";

export type CursorCloudExecutionResult = {
  output: string;
  exitCode: number;
};

export type CursorCloudOptions = {
  apiKey: string | undefined;
  output: CursorOutputMode;
  pretty: boolean;
};

type Args = string[];

/** Parsed top-level cursor cloud command. Splits the namespaces and the rest. */
export type CursorCloudCommand = {
  group: "agents" | "runs" | "artifacts" | "repos" | "models" | "me";
  sub: string;
  rest: string[];
};

export function parseCursorCloudCommand(args: Args): CursorCloudCommand | null {
  const cleaned = [...args];
  const group = nextPositional(cleaned);
  if (!group) return null;
  const groupAlias: Record<string, CursorCloudCommand["group"]> = {
    agents: "agents",
    agent: "agents",
    runs: "runs",
    run: "runs",
    artifacts: "artifacts",
    artifact: "artifacts",
    repos: "repos",
    repo: "repos",
    repositories: "repos",
    models: "models",
    model: "models",
    me: "me",
    user: "me",
    whoami: "me",
  };
  const canonical = groupAlias[group.toLowerCase()];
  if (!canonical) {
    throw new CursorCloudUsageError(
      `Unknown 'cursor cloud' group '${group}'. Try 'agents', 'runs', 'artifacts', 'repos', 'models', or 'me'.`,
    );
  }
  if (canonical === "me") {
    return { group: "me", sub: "show", rest: cleaned };
  }
  const sub = nextPositional(cleaned) ?? defaultSub(canonical);
  return { group: canonical, sub: sub.toLowerCase(), rest: cleaned };
}

function defaultSub(group: CursorCloudCommand["group"]): string {
  if (group === "agents") return "list";
  if (group === "runs") return "list";
  if (group === "artifacts") return "list";
  if (group === "repos") return "list";
  if (group === "models") return "list";
  return "list";
}

function nextPositional(args: Args): string | null {
  const idx = args.findIndex((arg) => arg !== "--" && !arg.startsWith("-"));
  if (idx < 0) return null;
  const [value] = args.splice(idx, 1);
  return value ?? null;
}

function readValue(args: Args, names: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) continue;
    const matched = names.find((name) => token === name || token.startsWith(`${name}=`));
    if (!matched) continue;
    if (token.includes("=")) {
      args.splice(i, 1);
      return token.slice(token.indexOf("=") + 1);
    }
    const value = args[i + 1];
    if (value == null) {
      throw new CursorCloudUsageError(`${token} requires a value.`);
    }
    args.splice(i, 2);
    return value;
  }
  return null;
}

function readFlag(args: Args, names: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    if (!names.includes(args[i]!)) continue;
    args.splice(i, 1);
    return true;
  }
  return false;
}

function readIntOption(args: Args, names: string[]): number | undefined {
  const raw = readValue(args, names);
  if (raw == null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CursorCloudUsageError(`${names[0]} must be a positive integer.`);
  }
  return parsed;
}

function requireValue(value: string | null | undefined, label: string): string {
  if (value && value.trim().length > 0) return value.trim();
  throw new CursorCloudUsageError(`${label} is required.`);
}

function resolveApiKey(args: Args): string | undefined {
  const fromFlag = readValue(args, ["--api-key", "--apiKey", "--key"]);
  if (fromFlag && fromFlag.trim().length) return fromFlag.trim();
  const fromEnv = process.env.CURSOR_API_KEY;
  if (fromEnv && fromEnv.trim().length) return fromEnv.trim();
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatOutput(value: unknown, options: CursorCloudOptions): string {
  if (options.output === "text") {
    return ensureTrailingNewline(value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
  return `${JSON.stringify(value, null, options.pretty ? 2 : 0)}\n`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function trimWhitespace(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function readCursorModelId(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.id === "string" && value.id.trim()) return value.id.trim();
  if (isRecord(value.model) && typeof value.model.id === "string") return value.model.id.trim();
  return "";
}

/** Top-level entry point. Dispatches to the right group/sub handler. */
export async function runCursorCloud(args: Args, outputMode: CursorOutputMode): Promise<CursorCloudExecutionResult> {
  const cleaned = [...args];
  const apiKey = resolveApiKey(cleaned);
  const output: CursorOutputMode = readFlag(cleaned, ["--text"]) ? "text" : readFlag(cleaned, ["--json"]) ? "json" : outputMode;
  const pretty = readFlag(cleaned, ["--compact"]) ? false : true;
  const opts: CursorCloudOptions = { apiKey, output, pretty };

  const command = parseCursorCloudCommand(cleaned);
  if (!command) {
    throw new CursorCloudUsageError("ade cursor cloud requires a subgroup. Try 'agents', 'runs', 'artifacts', 'repos', 'models', or 'me'.");
  }

  if (command.group === "agents") return runAgentsGroup(command.sub, command.rest, opts);
  if (command.group === "runs") return runRunsGroup(command.sub, command.rest, opts);
  if (command.group === "artifacts") return runArtifactsGroup(command.sub, command.rest, opts);
  if (command.group === "repos") return runReposGroup(command.sub, command.rest, opts);
  if (command.group === "models") return runModelsGroup(command.sub, command.rest, opts);
  if (command.group === "me") return runMe(command.rest, opts);
  throw new CursorCloudUsageError(`Unhandled cursor cloud group '${(command as { group: string }).group}'.`);
}

async function runAgentsGroup(sub: string, rest: Args, opts: CursorCloudOptions): Promise<CursorCloudExecutionResult> {
  const { Agent } = await getSdk();
  if (sub === "list" || sub === "ls") {
    const includeArchived = readFlag(rest, ["--archived", "--include-archived"]);
    const limit = readIntOption(rest, ["--limit"]);
    const cursor = trimWhitespace(readValue(rest, ["--cursor", "--page"]));
    const result = await Agent.list({
      runtime: "cloud",
      apiKey: opts.apiKey,
      includeArchived: includeArchived || undefined,
      limit,
      cursor,
    });
    if (opts.output === "text") return success(formatAgentTable(result), opts);
    return success(result, opts);
  }
  if (sub === "create" || sub === "send") {
    const repo = requireValue(readValue(rest, ["--repo", "--repo-url", "--url"]), "--repo");
    const prompt = requireValue(readValue(rest, ["--prompt", "--message", "-m"]), "--prompt");
    const branch = trimWhitespace(readValue(rest, ["--branch", "--starting-ref", "--ref"]));
    const modelId = trimWhitespace(readValue(rest, ["--model", "--model-id"]));
    const prUrl = trimWhitespace(readValue(rest, ["--pr-url", "--pr"]));
    const autoCreatePR = readFlag(rest, ["--auto-pr", "--auto-create-pr"]);
    const workOnCurrentBranch = readFlag(rest, ["--work-on-current-branch"]);
    const name = trimWhitespace(readValue(rest, ["--name", "--agent-name"]));

    const repoEntry: { url: string; startingRef?: string; prUrl?: string } = { url: repo };
    if (branch) repoEntry.startingRef = branch;
    if (prUrl) repoEntry.prUrl = prUrl;
    const cloudOptions: { apiKey?: string; name?: string; model?: { id: string }; cloud: { repos: Array<typeof repoEntry>; workOnCurrentBranch?: boolean; autoCreatePR?: boolean; skipReviewerRequest?: boolean } } = {
      apiKey: opts.apiKey,
      name,
      cloud: {
        repos: [repoEntry],
        workOnCurrentBranch: workOnCurrentBranch || undefined,
        autoCreatePR: autoCreatePR || undefined,
        skipReviewerRequest: true,
      },
    };
    if (modelId) cloudOptions.model = { id: modelId };

    const agent = await Agent.create(cloudOptions);
    try {
      const sendOpts = modelId ? { model: { id: modelId } } : undefined;
      const run = await agent.send(prompt, sendOpts);
      const summary = await streamRun(run, opts);
      return success({ agentId: agent.agentId, runId: run.id, ...summary }, opts);
    } finally {
      try {
        await agent[Symbol.asyncDispose]?.();
      } catch {
        try { agent.close(); } catch { /* ignore */ }
      }
    }
  }
  if (sub === "resume" || sub === "followup" || sub === "follow-up" || sub === "reply") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id", "--id"]), "--agent");
    const prompt = requireValue(readValue(rest, ["--prompt", "--message", "-m"]), "--prompt");
    const modelId = trimWhitespace(readValue(rest, ["--model", "--model-id"]));
    const partial: { apiKey?: string; model?: { id: string } } = { apiKey: opts.apiKey };
    if (modelId) partial.model = { id: modelId };
    const agent = await Agent.resume(agentId, partial);
    try {
      const sendOpts = modelId ? { model: { id: modelId } } : undefined;
      const run = await agent.send(prompt, sendOpts);
      const summary = await streamRun(run, opts);
      return success({ agentId: agent.agentId, runId: run.id, ...summary }, opts);
    } finally {
      try {
        await agent[Symbol.asyncDispose]?.();
      } catch {
        try { agent.close(); } catch { /* ignore */ }
      }
    }
  }
  if (sub === "show" || sub === "get" || sub === "info") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id", "--id"]), "--agent");
    const agent = await Agent.get(agentId, { apiKey: opts.apiKey });
    if (opts.output === "text") return success(formatAgentTable({ items: [agent] }), opts);
    return success(agent, opts);
  }
  if (sub === "archive") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id", "--id"]), "--agent");
    await Agent.archive(agentId, { apiKey: opts.apiKey });
    return success({ ok: true, agentId, action: "archive" }, opts);
  }
  if (sub === "unarchive") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id", "--id"]), "--agent");
    await Agent.unarchive(agentId, { apiKey: opts.apiKey });
    return success({ ok: true, agentId, action: "unarchive" }, opts);
  }
  if (sub === "delete" || sub === "rm") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id", "--id"]), "--agent");
    await Agent.delete(agentId, { apiKey: opts.apiKey });
    return success({ ok: true, agentId, action: "delete" }, opts);
  }
  if (sub === "cancel") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id"]), "--agent");
    const runId = requireValue(readValue(rest, ["--run", "--run-id"]), "--run");
    const run = await Agent.getRun(runId, { runtime: "cloud", agentId, apiKey: opts.apiKey });
    await run.cancel();
    return success({ ok: true, runId, action: "cancel" }, opts);
  }
  throw new CursorCloudUsageError(`Unknown 'cursor cloud agents' subcommand '${sub}'.`);
}

async function runRunsGroup(sub: string, rest: Args, opts: CursorCloudOptions): Promise<CursorCloudExecutionResult> {
  const { Agent } = await getSdk();
  if (sub === "list" || sub === "ls") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id"]), "--agent");
    const limit = readIntOption(rest, ["--limit"]);
    const cursor = trimWhitespace(readValue(rest, ["--cursor", "--page"]));
    const result = await Agent.listRuns(agentId, { runtime: "cloud", apiKey: opts.apiKey, limit, cursor });
    if (opts.output === "text") return success(formatRunTable(result), opts);
    return success(result, opts);
  }
  if (sub === "show" || sub === "get") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id"]), "--agent");
    const runId = requireValue(readValue(rest, ["--run", "--run-id"]), "--run");
    const run = await Agent.getRun(runId, { runtime: "cloud", agentId, apiKey: opts.apiKey });
    const conversation = await run.conversation();
    if (opts.output === "text") return success(formatConversation(conversation), opts);
    return success({
      id: run.id,
      agentId: run.agentId,
      status: run.status,
      model: run.model,
      durationMs: run.durationMs,
      git: run.git,
      result: run.result,
      conversation,
    }, opts);
  }
  if (sub === "cancel") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id"]), "--agent");
    const runId = requireValue(readValue(rest, ["--run", "--run-id"]), "--run");
    const run = await Agent.getRun(runId, { runtime: "cloud", agentId, apiKey: opts.apiKey });
    await run.cancel();
    return success({ ok: true, runId, action: "cancel" }, opts);
  }
  throw new CursorCloudUsageError(`Unknown 'cursor cloud runs' subcommand '${sub}'.`);
}

async function runArtifactsGroup(sub: string, rest: Args, opts: CursorCloudOptions): Promise<CursorCloudExecutionResult> {
  const { Agent } = await getSdk();
  if (sub === "list" || sub === "ls") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id"]), "--agent");
    const agent = await Agent.resume(agentId, { apiKey: opts.apiKey });
    try {
      const items = await agent.listArtifacts();
      if (opts.output === "text") return success(formatArtifactTable(items), opts);
      return success({ items }, opts);
    } finally {
      try {
        await agent[Symbol.asyncDispose]?.();
      } catch {
        try { agent.close(); } catch { /* ignore */ }
      }
    }
  }
  if (sub === "download" || sub === "get") {
    const agentId = requireValue(readValue(rest, ["--agent", "--agent-id"]), "--agent");
    const remote = requireValue(readValue(rest, ["--path", "--remote", "--remote-path"]), "--path");
    const out = trimWhitespace(readValue(rest, ["--out", "--output", "--dest"]));
    const agent = await Agent.resume(agentId, { apiKey: opts.apiKey });
    try {
      const buf = await agent.downloadArtifact(remote);
      const data = Buffer.from(buf);
      if (out) {
        const target = path.resolve(out);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
        return success({ ok: true, path: remote, savedTo: target, sizeBytes: data.byteLength }, opts);
      }
      if (opts.output === "text") {
        // Stream binary directly to stdout when no destination is given. We do
        // NOT try to render binary as text; surface the size and base64 hint.
        return success({ ok: true, path: remote, sizeBytes: data.byteLength, base64: data.toString("base64") }, opts);
      }
      return success({ ok: true, path: remote, sizeBytes: data.byteLength, base64: data.toString("base64") }, opts);
    } finally {
      try {
        await agent[Symbol.asyncDispose]?.();
      } catch {
        try { agent.close(); } catch { /* ignore */ }
      }
    }
  }
  throw new CursorCloudUsageError(`Unknown 'cursor cloud artifacts' subcommand '${sub}'.`);
}

async function runReposGroup(sub: string, rest: Args, opts: CursorCloudOptions): Promise<CursorCloudExecutionResult> {
  const { Cursor } = await getSdk();
  if (sub === "list" || sub === "ls") {
    void rest; // no extra flags supported today
    const items = await Cursor.repositories.list({ apiKey: opts.apiKey });
    if (opts.output === "text") {
      const lines = ["Cursor cloud repositories"];
      if (!items.length) lines.push("  (none)");
      else for (const r of items) lines.push(`  ${r.url}`);
      return success(lines.join("\n"), opts);
    }
    return success({ items }, opts);
  }
  throw new CursorCloudUsageError(`Unknown 'cursor cloud repos' subcommand '${sub}'.`);
}

async function runModelsGroup(sub: string, rest: Args, opts: CursorCloudOptions): Promise<CursorCloudExecutionResult> {
  const { Cursor } = await getSdk();
  if (sub === "list" || sub === "ls") {
    void rest;
    const items = await Cursor.models.list({ apiKey: opts.apiKey });
    if (opts.output === "text") {
      const lines = ["Cursor cloud models"];
      if (!items.length) lines.push("  (none)");
      else for (const m of items) {
        const id = readCursorModelId(m);
        const display = isRecord(m) && typeof m.displayName === "string" ? m.displayName : id;
        lines.push(`  ${display}${id && display !== id ? ` (${id})` : ""}`);
      }
      return success(lines.join("\n"), opts);
    }
    return success({ items }, opts);
  }
  throw new CursorCloudUsageError(`Unknown 'cursor cloud models' subcommand '${sub}'.`);
}

async function runMe(rest: Args, opts: CursorCloudOptions): Promise<CursorCloudExecutionResult> {
  void rest;
  const { Cursor } = await getSdk();
  const me = await Cursor.me({ apiKey: opts.apiKey });
  if (opts.output === "text") {
    const lines = ["Cursor cloud account"];
    lines.push(`  apiKeyName: ${me.apiKeyName}`);
    if (me.userEmail) lines.push(`  userEmail:  ${me.userEmail}`);
    if (me.createdAt) lines.push(`  createdAt:  ${me.createdAt}`);
    return success(lines.join("\n"), opts);
  }
  return success(me, opts);
}

/** Streams a run, prints text deltas to stderr, and returns a terse summary. */
async function streamRun(run: Awaited<ReturnType<Awaited<ReturnType<CursorSdk["Agent"]["create"]>>["send"]>>, opts: CursorCloudOptions): Promise<{ status: string; durationMs?: number; resultText?: string }> {
  const printText = opts.output === "text";
  try {
    for await (const event of run.stream()) {
      if (!isRecord(event)) continue;
      const t = (event as { type?: string }).type;
      if (t === "assistant") {
        const message = (event as { message?: { content?: Array<{ type?: string; text?: string }> } }).message;
        const blocks = message?.content ?? [];
        for (const block of blocks) {
          if (block && block.type === "text" && typeof block.text === "string" && block.text.length) {
            if (printText) process.stderr.write(block.text);
          }
        }
        if (printText) process.stderr.write("\n");
      } else if (t === "thinking") {
        // Emit nothing; thinking is deliberate noise on a CLI.
      } else if (t === "status") {
        const status = (event as { status?: string }).status;
        if (printText && status) process.stderr.write(`[${status}]\n`);
      }
    }
  } catch (error) {
    if (printText) process.stderr.write(`(stream interrupted: ${error instanceof Error ? error.message : String(error)})\n`);
  }
  const result = await run.wait();
  return {
    status: result.status,
    durationMs: result.durationMs,
    resultText: result.result,
  };
}

function success(value: unknown, opts: CursorCloudOptions): CursorCloudExecutionResult {
  return { output: formatOutput(value, opts), exitCode: 0 };
}

function formatAgentTable(value: unknown): string {
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  if (!items.length) return "Cursor cloud agents\n  (none)";
  const lines = ["Cursor cloud agents"];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = String(item.agentId ?? "");
    const name = typeof item.name === "string" ? item.name : "";
    const status = typeof item.status === "string" ? item.status : "";
    const archived = item.archived === true ? "archived" : "";
    const lastModified = typeof item.lastModified === "number"
      ? new Date(item.lastModified).toISOString()
      : "";
    const tags = [status, archived].filter(Boolean).join(",");
    lines.push(`  ${id}  ${truncate(name, 40)}  ${tags}${lastModified ? `  ${lastModified}` : ""}`);
  }
  return lines.join("\n");
}

function formatRunTable(value: unknown): string {
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  if (!items.length) return "Cursor cloud runs\n  (none)";
  const lines = ["Cursor cloud runs"];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = String(item.id ?? "");
    const status = String(item.status ?? "");
    const created = typeof item.createdAt === "number" ? new Date(item.createdAt).toISOString() : "";
    lines.push(`  ${id}  ${status}${created ? `  ${created}` : ""}`);
  }
  return lines.join("\n");
}

function formatConversation(turns: unknown): string {
  if (!Array.isArray(turns) || turns.length === 0) return "Cursor cloud conversation\n  (no turns)";
  const out: string[] = ["Cursor cloud conversation"];
  for (const turn of turns) {
    if (!isRecord(turn)) continue;
    const role = String(turn.role ?? turn.turnType ?? "turn");
    const text = extractTurnText(turn);
    out.push(`  ${role}:`);
    if (text) {
      for (const line of text.split("\n")) out.push(`    ${line}`);
    }
  }
  return out.join("\n");
}

function extractTurnText(turn: Record<string, unknown>): string {
  // Conversation turns can be {role, content: TextBlock[]}, plain strings, or
  // shell turns. Pull out anything that looks like display text.
  if (typeof turn.content === "string") return turn.content;
  if (Array.isArray(turn.content)) {
    return turn.content
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("");
  }
  if (typeof turn.text === "string") return turn.text;
  return "";
}

function formatArtifactTable(items: Array<{ path: string; sizeBytes?: number; updatedAt?: string }>): string {
  if (!items.length) return "Cursor cloud artifacts\n  (none)";
  const lines = ["Cursor cloud artifacts"];
  for (const a of items) {
    const size = typeof a.sizeBytes === "number" ? `${a.sizeBytes}` : "";
    lines.push(`  ${a.path}${size ? `  ${size}b` : ""}${a.updatedAt ? `  ${a.updatedAt}` : ""}`);
  }
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Help texts. Top-level `cursor cloud` plus per-group. */
export const CURSOR_CLOUD_HELP: Record<string, string> = {
  cloud: `  Cursor Cloud (via @cursor/sdk)

  Two ADE entry points are mirrored here:
    1. "Send to Cursor Cloud"      ade cursor cloud agents create --repo ... --prompt ...
    2. "Open existing cloud chat"  ade cursor cloud agents resume --agent <id> --prompt ...

    $ ade cursor cloud agents list | create | resume | show | archive | unarchive | delete | cancel
    $ ade cursor cloud runs list | show | cancel
    $ ade cursor cloud artifacts list | download
    $ ade cursor cloud repos list
    $ ade cursor cloud models list
    $ ade cursor cloud me

  Auth:
    --api-key <key>        Cursor API key. Falls back to CURSOR_API_KEY env var.

  Output:
    --json                 Machine-readable JSON (default).
    --text                 Compact human-readable summary.
    --compact              Single-line JSON (with --json).
`,
  agents: `  Cursor Cloud: agents

    $ ade cursor cloud agents list [--archived] [--limit N] [--cursor C]
    $ ade cursor cloud agents create --repo <git-url> --prompt <text>
        [--branch <ref>] [--model <id>] [--pr-url <url>]
        [--auto-pr] [--work-on-current-branch] [--name <agent-name>]
    $ ade cursor cloud agents resume --agent <id> --prompt <text> [--model <id>]
    $ ade cursor cloud agents show --agent <id>
    $ ade cursor cloud agents archive --agent <id>
    $ ade cursor cloud agents unarchive --agent <id>
    $ ade cursor cloud agents delete --agent <id>
    $ ade cursor cloud agents cancel --agent <id> --run <id>

  Notes:
    - "create" launches a fresh cloud agent and streams the first prompt.
      skipReviewerRequest is always set to true (matches ADE desktop).
    - "resume" mirrors an existing cloud agent and sends a follow-up prompt.
    - With --text the assistant text is streamed to stderr while events arrive.
`,
  runs: `  Cursor Cloud: runs

    $ ade cursor cloud runs list   --agent <id> [--limit N] [--cursor C]
    $ ade cursor cloud runs show   --agent <id> --run <id>
    $ ade cursor cloud runs cancel --agent <id> --run <id>

  "show" prints the conversation turns. With --json the response also includes
  status / model / durationMs / git so consumers can resume programmatically.
`,
  artifacts: `  Cursor Cloud: artifacts

    $ ade cursor cloud artifacts list     --agent <id>
    $ ade cursor cloud artifacts download --agent <id> --path <remote>
        [--out <local-path>]

  Without --out the file is returned base64-encoded in JSON. With --out the
  file is written to disk and the JSON includes savedTo + sizeBytes.
`,
  repos: `  Cursor Cloud: repos

    $ ade cursor cloud repos list

  Lists GitHub repositories the authenticated user has connected to Cursor.
  Use the URL field as --repo on "agents create".
`,
  models: `  Cursor Cloud: models

    $ ade cursor cloud models list

  Lists models available for cloud agents. Use the top-level id field as
  --model on "agents create" / "agents resume". Older nested "model.id"
  rows are still accepted for compatibility.
`,
  me: `  Cursor Cloud: me

    $ ade cursor cloud me

  Returns the authenticated API key's metadata: apiKeyName, userEmail (if
  visible), and createdAt. Useful for verifying which key the CLI is using.
`,
};
