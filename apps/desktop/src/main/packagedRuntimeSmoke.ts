import { resolveClaudeCodeExecutable, type ClaudeCodeExecutableResolution } from "./services/ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "./services/ai/codexExecutable";
import {
  classifyClaudeStartupFailure,
  type ClaudeStartupProbeResult,
} from "./packagedRuntimeSmokeShared";

const PTY_PROBE_TIMEOUT_MS = 4_000;
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
      reject(new Error("PTY probe timed out"));
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

async function probeClaudeStartup(
  claudeExecutable: ClaudeCodeExecutableResolution,
): Promise<ClaudeStartupProbeResult> {
  const claude = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CLAUDE_PROBE_TIMEOUT_MS);
  const stream = claude.query({
    prompt: "System initialization check. Respond with only the word READY.",
    options: {
      cwd: process.cwd(),
      permissionMode: "plan",
      tools: [],
      pathToClaudeCodeExecutable: claudeExecutable.path,
      abortController,
    },
  });

  try {
    for await (const message of stream) {
      if (message.type === "auth_status" && message.error) {
        return { state: "auth-failed", message: message.error };
      }
      if (message.type === "assistant" && message.error === "authentication_failed") {
        return { state: "auth-failed", message: "authentication_failed" };
      }
      if (message.type !== "result") continue;
      if (!message.is_error) {
        return { state: "ready", message: null };
      }
      const errors =
        "errors" in message && Array.isArray(message.errors)
          ? message.errors.filter(Boolean).join(" ")
          : "";
      return classifyClaudeStartupFailure(errors || "Claude startup probe returned an error result.", claudeExecutable.source);
    }

    return {
      state: "runtime-failed",
      message: "Claude startup probe completed without a terminal result.",
    };
  } catch (error) {
    return classifyClaudeStartupFailure(error, claudeExecutable.source);
  } finally {
    clearTimeout(timeout);
    try {
      stream.close();
    } catch {
      // ignore best-effort cleanup
    }
  }
}

async function main(): Promise<void> {
  const pty = await import("node-pty");
  const claude = await import("@anthropic-ai/claude-agent-sdk");
  const claudeExecutable = resolveClaudeCodeExecutable();
  const ptyProbe = await probePty();
  const claudeStartup = await probeClaudeStartup(claudeExecutable);

  process.stdout.write(JSON.stringify({
    ok: true,
    nodePty: typeof pty.spawn,
    claudeQuery: typeof claude.query,
    claudeExecutablePath: claudeExecutable.path,
    claudeExecutableSource: claudeExecutable.source,
    claudeStartup,
    codexExecutable: typeof resolveCodexExecutable,
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
