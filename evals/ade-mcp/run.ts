/**
 * The ADE MCP eval: replays realistic requests from an outside agent (claude.ai,
 * Claude Code, ChatGPT…) against ADE MCP's real tool text, and grades the tool
 * calls the model makes. See README.md.
 *
 *   npm run eval -- --model haiku,sonnet [--case id,id] [--samples 1] [--out runs/x]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutableCandidatesFromKnownLocations } from "../../apps/desktop/src/main/services/ai/cliExecutableResolver";
import {
  preferNativeExecutablePath,
  resolveCliSpawnInvocation,
} from "../../apps/desktop/src/main/services/shared/processExecution";
import { signalChildProcessTree } from "../../apps/desktop/src/main/services/shared/utils";
import { grade, type Grading, type ToolCall } from "./graders";

export type EvalCase = {
  id: string;
  /** The real request or past mistake this case reproduces. */
  why: string;
  scope: "read" | "write";
  prompt: string;
  /** Scripted `ade … --json` output per typed tool, served in order (the last repeats). `{ "$error": "…" }` fails the command. */
  results?: Record<string, unknown[]>;
  /** Output for the raw `ade` tool, by a regex on its words. */
  ade?: Array<{ match: string; text: string; isError?: boolean }>;
  grade: Grading;
};

type RunResult = {
  caseId: string;
  model: string;
  sample: number;
  pass: boolean;
  failures: string[];
  calls: ToolCall[];
  /** Tool calls the model attempted that never reached the server (not allowed, unknown). */
  blocked: string[];
  reply: string;
  costUsd: number | null;
  turns: number | null;
  error?: string;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX = path.resolve(HERE, "../../apps/ade-cli/node_modules/tsx/dist/cli.mjs");
const CASES_PATH = path.join(HERE, "cases.ndjson");
const RUN_TIMEOUT_MS = 240_000;
const SYSTEM_PROMPT = [
  "You are Claude, a helpful assistant in a chat app.",
  "The person has connected ADE, the app they code with, as the MCP server `ade`. Use its tools to do what they ask, then answer briefly.",
  "Today is 2026-10-28.",
].join(" ");

function option(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

export function loadCases(file = CASES_PATH): EvalCase[] {
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as EvalCase);
}

/** The environment of a run: nothing from the ADE chat or Claude session this runs in. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ADE_") || key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE") continue;
    env[key] = value;
  }
  return env;
}

/**
 * How to start `claude` here: its native binary when one is installed. On
 * Windows an npm `claude.cmd` shim cannot be spawned directly, so it goes
 * through cmd.exe the way ADE starts any `.cmd` (`resolveCliSpawnInvocation`).
 */
function claudeInvocation(args: string[], env: NodeJS.ProcessEnv) {
  const candidates = resolveExecutableCandidatesFromKnownLocations("claude", env).map((candidate) => candidate.path);
  return resolveCliSpawnInvocation(preferNativeExecutablePath(candidates) ?? "claude", args, env);
}

async function runOne(evalCase: EvalCase, model: string, sample: number, outDir: string): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mcp-eval-"));
  const logPath = path.join(dir, "calls.ndjson");
  fs.writeFileSync(logPath, "");
  const configPath = path.join(dir, "mcp.json");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      ade: {
        type: "stdio",
        command: process.execPath,
        args: [TSX, path.join(HERE, "fakeServer.ts"), "--cases", CASES_PATH, "--case", evalCase.id, "--log", logPath],
      },
    },
  }));
  const args = [
    "-p", evalCase.prompt,
    "--model", model,
    "--mcp-config", configPath,
    "--strict-mcp-config",
    "--tools", "",
    "--allowedTools", "mcp__ade",
    "--system-prompt", SYSTEM_PROMPT,
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources", "",
    "--max-budget-usd", "1",
  ];
  const lines: string[] = [];
  const stderr: string[] = [];
  const exit = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const env = cleanEnv();
    const invocation = claudeInvocation(args, env);
    const child = spawn(invocation.command, invocation.args, {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      lines.push(...parts.filter((line) => line.trim()));
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    const timer = setTimeout(() => {
      // The whole tree: on Windows a `.cmd` shim leaves `claude` under cmd.exe.
      signalChildProcessTree(child, "SIGKILL");
      resolve({ code: null, timedOut: true });
    }, RUN_TIMEOUT_MS);
    // `claude` missing or not startable: a failed case, not a crashed run.
    child.on("error", (error) => {
      clearTimeout(timer);
      stderr.push(`spawn failed: ${error.message}`);
      resolve({ code: null, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) lines.push(buffer);
      resolve({ code, timedOut: false });
    });
  });
  const events = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, any>];
    } catch {
      return [];
    }
  });
  const final = [...events].reverse().find((event) => event.type === "result");
  const attempted = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => (event.message?.content ?? []) as Array<Record<string, any>>)
    .filter((block) => block.type === "tool_use")
    .map((block) => String(block.name));
  const calls = fs.readFileSync(logPath, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ToolCall);
  const reached = calls.length;
  const blocked = attempted.filter((name) => !name.startsWith("mcp__ade__")).concat(
    attempted.filter((name) => name.startsWith("mcp__ade__")).length > reached ? ["(some ade calls did not reach the server)"] : [],
  );
  const reply = typeof final?.result === "string" ? final.result : "";
  const verdict = grade(evalCase.grade, calls, reply);
  const error = exit.timedOut
    ? "timed out"
    : !final ? `no result (exit ${exit.code}): ${stderr.join("").slice(0, 400)}` : undefined;
  const result: RunResult = {
    caseId: evalCase.id,
    model,
    sample,
    pass: verdict.pass && !error,
    failures: error ? [error, ...verdict.failures] : verdict.failures,
    calls,
    blocked,
    reply,
    costUsd: typeof final?.total_cost_usd === "number" ? final.total_cost_usd : null,
    turns: typeof final?.num_turns === "number" ? final.num_turns : null,
    ...(error ? { error } : {}),
  };
  fs.writeFileSync(path.join(outDir, `${evalCase.id}.${model}.${sample}.json`), JSON.stringify({ ...result, events }, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

async function main(): Promise<void> {
  const models = (option("--model", "haiku") ?? "haiku").split(",").map((model) => model.trim()).filter(Boolean);
  const wanted = option("--case")?.split(",").map((id) => id.trim()).filter(Boolean) ?? null;
  const samples = Math.max(1, Number(option("--samples", "1")));
  const concurrency = Math.max(1, Number(option("--concurrency", "4")));
  const outDir = path.resolve(option("--out") ?? path.join(HERE, "runs", new Date().toISOString().replace(/[:.]/g, "-")));
  fs.mkdirSync(outDir, { recursive: true });
  const cases = loadCases().filter((entry) => !wanted || wanted.includes(entry.id));
  if (wanted && cases.length !== wanted.length) throw new Error(`Unknown case in ${wanted.join(",")}`);
  const jobs = models.flatMap((model) => cases.flatMap((evalCase) =>
    Array.from({ length: samples }, (_, sample) => ({ evalCase, model, sample }))));
  const results = await pool(jobs, concurrency, async ({ evalCase, model, sample }) => {
    const result = await runOne(evalCase, model, sample, outDir);
    process.stdout.write(`${result.pass ? "PASS" : "FAIL"} ${model} ${evalCase.id}#${sample}`
      + `${result.pass ? "" : `: ${result.failures.join(" | ")}`}\n`);
    return result;
  });
  console.log("");
  for (const model of models) {
    const mine = results.filter((result) => result.model === model);
    const byCase = new Map<string, boolean>();
    for (const result of mine) byCase.set(result.caseId, (byCase.get(result.caseId) ?? true) && result.pass);
    const cost = mine.reduce((sum, result) => sum + (result.costUsd ?? 0), 0);
    console.log(`${model}: ${[...byCase.values()].filter(Boolean).length} of ${byCase.size} cases, `
      + `${mine.filter((result) => result.pass).length} of ${mine.length} samples, $${cost.toFixed(3)} (API-equivalent)`);
  }
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(results.map(({ caseId, model, sample, pass, failures, costUsd, calls }) => ({
    caseId, model, sample, pass, failures, costUsd, calls: calls.map((call) => call.name),
  })), null, 2));
  console.log(`Runs: ${outDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
