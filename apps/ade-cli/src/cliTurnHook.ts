import {
  CLI_TURN_HOOK_SOCKET_ENV,
  CLI_TURN_HOOK_TOKEN_ENV,
  claudeHookPayloadSummary,
} from "../../desktop/src/main/services/pty/cliTurnSignals";

/**
 * `ade __ade-cli-turn-hook claude <session-id>`: the command ADE's Claude hooks
 * run (pty/cliTurnSignals.ts). It reads the hook's JSON from stdin and hands
 * the few fields that say where the turn is to the runtime that owns the
 * terminal, named by `ADE_CLI_TURN_HOOK_SOCKET`.
 *
 * It must never get in Claude's way: it prints nothing, always exits 0, gives
 * up after a few seconds, and does nothing when ADE is gone. `--socket` makes
 * the call go to that runtime only; it never starts or replaces a brain.
 */

const STDIN_LIMIT_BYTES = 256 * 1024;
const STDIN_WAIT_MS = 2_000;
const REPORT_DEADLINE_MS = 5_000;

type RunCli = (argv: string[]) => Promise<{ output: string; exitCode: number }>;

function readHookStdin(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeAllListeners("data");
      stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    stdin.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > STDIN_LIMIT_BYTES) {
        // A payload this big carries a transcript or a prompt, not a state; the
        // fields ADE reads come first, so what was read is enough.
        chunks.push(buffer.subarray(0, Math.max(0, buffer.length - (size - STDIN_LIMIT_BYTES))));
        finish();
        return;
      }
      chunks.push(buffer);
    });
    stdin.once("end", finish);
    stdin.once("error", finish);
  });
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    // A payload cut at the size limit no longer parses; pick the fields out.
    const pick = (key: string): string | null => {
      const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
      return match?.[1] ?? null;
    };
    const event = pick("hook_event_name");
    if (!event) return null;
    const payload: Record<string, unknown> = { hook_event_name: event };
    for (const key of ["prompt_id", "notification_type", "tool_name", "agent_id", "agent_type"]) {
      const value = pick(key);
      if (value) payload[key] = value;
    }
    return payload;
  }
}

export async function runCliTurnHook(argv: string[], runCli: RunCli): Promise<void> {
  try {
    const provider = argv[0]?.trim() ?? "";
    const sessionId = argv[1]?.trim() ?? "";
    const socketPath = process.env[CLI_TURN_HOOK_SOCKET_ENV]?.trim() ?? "";
    if (provider !== "claude" || !sessionId || !socketPath) return;
    const payload = parsePayload(await readHookStdin());
    if (!payload) return;
    const summary = claudeHookPayloadSummary(payload);
    if (!summary.hook_event_name) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      runCli([
        "--socket",
        socketPath,
        "actions",
        "run",
        "session.reportCliTurnSignal",
        "--input-json",
        JSON.stringify({ sessionId, provider, payload: summary, token: process.env[CLI_TURN_HOOK_TOKEN_ENV]?.trim() ?? "" }),
      ]).catch(() => null),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REPORT_DEADLINE_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  } catch {
    // Claude's turn does not wait on ADE, and a hook failure must not show.
  } finally {
    process.exitCode = 0;
  }
}
