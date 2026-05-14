import os from "node:os";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeCodeExecutable } from "./services/ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "./services/ai/codexExecutable";
import {
  classifyClaudeStartupFailure,
  type ClaudeStartupProbeResult,
} from "./packagedRuntimeSmokeShared";

const PTY_PROBE_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 4_000;
const CLAUDE_PROBE_TIMEOUT_MS = 20_000;

async function probePty(): Promise<{ ok: true; output: string }> {
  const pty = await import("node-pty");
  return new Promise((resolve, reject) => {
    let output = "";
    const shellSpec =
      process.platform === "win32"
        ? { file: "powershell.exe", args: ["-NoProfile", "-Command", 'Write-Output "ADE_PTY_OK"'] }
        : { file: "/bin/sh", args: ["-lc", 'printf "ADE_PTY_OK\\n"'] };
    const term = pty.spawn(shellSpec.file, shellSpec.args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env },
    });

    const timeout = setTimeout(() => {
      try {
        term.kill();
      } catch {
        // ignore best-effort cleanup
      }
      reject(new Error(`PTY probe timed out after ${PTY_PROBE_TIMEOUT_MS}ms`));
    }, PTY_PROBE_TIMEOUT_MS);

    term.onData((chunk) => {
      output += chunk;
    });
    term.onExit((event) => {
      clearTimeout(timeout);
      if (!output.includes("ADE_PTY_OK")) {
        reject(new Error(`PTY probe exited without expected output (exit=${event.exitCode ?? "null"})`));
        return;
      }
      resolve({ ok: true, output });
    });
  });
}

async function probeClaudeStartup(): Promise<ClaudeStartupProbeResult> {
  const claude = await import("@anthropic-ai/claude-agent-sdk");
  const claudeExecutable = resolveClaudeCodeExecutable();
  const abortController = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    abortController.abort();
  }, CLAUDE_PROBE_TIMEOUT_MS);
  timeout.unref?.();
  let stream: Query | null = null;

  try {
    stream = claude.query({
      prompt: "System initialization check. Respond with only the word READY.",
      options: {
        cwd: os.tmpdir(),
        permissionMode: "plan",
        tools: [],
        abortController,
        pathToClaudeCodeExecutable: claudeExecutable.path,
      },
    });

    for await (const message of stream) {
      if (message.type === "auth_status" && message.error) {
        return { state: "auth-failed", message: message.error };
      }
      if (message.type === "assistant" && message.error === "authentication_failed") {
        return { state: "auth-failed", message: "authentication_failed" };
      }
      if (message.type !== "result") continue;
      if (message.subtype === "success") {
        return { state: "ready", message: null };
      }
      const errors = message.errors.filter(Boolean).join(" ");
      return classifyClaudeStartupFailure(errors || "Claude startup probe returned an error result.");
    }

    return {
      state: "runtime-failed",
      message: "Claude startup probe completed without a terminal result.",
    };
  } catch (error) {
    if (didTimeout) {
      return {
        state: "runtime-failed",
        message: `Claude startup probe timed out after ${CLAUDE_PROBE_TIMEOUT_MS}ms.`,
      };
    }
    return classifyClaudeStartupFailure(error);
  } finally {
    clearTimeout(timeout);
    try {
      stream?.close();
    } catch {
      // ignore best-effort cleanup
    }
  }
}

async function main(): Promise<void> {
  const pty = await import("node-pty");
  const claude = await import("@anthropic-ai/claude-agent-sdk");
  const claudeExecutable = resolveClaudeCodeExecutable();
  const codexExecutable = resolveCodexExecutable();
  const ptyProbe = await probePty();
  const claudeStartup = await probeClaudeStartup();

  process.stdout.write(JSON.stringify({
    ok: true,
    nodePty: typeof pty.spawn,
    claudeQuery: typeof claude.query,
    claudeExecutablePath: claudeExecutable.path,
    claudeExecutableSource: claudeExecutable.source,
    claudeStartup,
    codexExecutable: typeof resolveCodexExecutable,
    codexExecutablePath: codexExecutable.path,
    codexExecutableSource: codexExecutable.source,
    ptyProbe,
  }));
}

void main().then(
  () => {
    // Force a clean exit even if node-pty/Claude SDK/Codex left event-loop handles open.
    // Without this, the packaged Electron-as-node child can hang forever after writing JSON to stdout.
    // Flush stdout before exiting so the JSON payload isn't truncated.
    process.stdout.write("", () => process.exit(0));
  },
  (error) => {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
