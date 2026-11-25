import { createHash } from "node:crypto";
import { augmentProcessPathWithShellAndKnownCliDirs, setPathEnvValue } from "../ai/cliExecutableResolver";
import { stripHostRuntimeEnv } from "../shared/hostRuntimeEnv";
import { resolveWindowsCmdLineInvocation } from "../shared/processExecution";
import { runReapedCommand } from "../shared/runReapedCommand";
import type { ChatScheduledWorkCheckRun } from "./chatScheduledWorkScheduler";

/** A check that runs longer than this failed. */
export const SCHEDULED_WORK_CHECK_TIMEOUT_MS = 60_000;
/** Per stream. A check is meant to print a little, not a log. */
const CHECK_MAX_BUFFER = 1024 * 1024;
/** How much of the output the wake message quotes. */
const CHECK_DETAIL_CHARS = 2_000;
export const SCHEDULED_WORK_CHECK_MAX_CHARS = 1_000;

function tail(text: string, max = CHECK_DETAIL_CHARS): string {
  const trimmed = text.replace(/\r\n/g, "\n").trimEnd();
  return trimmed.length > max ? `…${trimmed.slice(trimmed.length - max + 1)}` : trimmed;
}

/**
 * The env a check runs in: the brain's, with the user's shell PATH merged in,
 * the same PATH lane setup commands get. A brain started by launchd has only
 * `/usr/bin:/bin`, where `gh` or `npm` would not be found.
 */
function checkEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  setPathEnvValue(env, augmentProcessPathWithShellAndKnownCliDirs({ env, includeInteractiveShell: true, preferShellOrder: true }));
  return stripHostRuntimeEnv(env);
}

/**
 * Run a scheduled-work check: one shell line in `cwd` (`/bin/sh -c` on macOS
 * and Linux, `cmd.exe /d /s /c` on Windows). It passes when it exits 0; its
 * hash is of stdout alone, so a progress line on stderr is not news.
 */
export async function runScheduledWorkCheck(
  command: string,
  cwd: string,
  timeoutMs = SCHEDULED_WORK_CHECK_TIMEOUT_MS,
): Promise<ChatScheduledWorkCheckRun> {
  const env = checkEnv();
  const invocation = process.platform === "win32"
    ? resolveWindowsCmdLineInvocation(command, env)
    : { command: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
  const result = await runReapedCommand(invocation.command, invocation.args, {
    cwd,
    env,
    timeoutMs,
    maxBuffer: CHECK_MAX_BUFFER,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.exitCode === 0 && !result.error) {
    const stdout = result.stdout.replace(/\r\n/g, "\n");
    return {
      ok: true,
      outputHash: createHash("sha256").update(stdout).digest("hex"),
      detail: tail(stdout) || "(no output)",
      exitCode: 0,
    };
  }
  const why = result.timedOut
    ? `Timed out after ${Math.round(timeoutMs / 1000)} s.`
    : result.error && result.exitCode == null
      ? result.error.message
      : `Exited with code ${result.exitCode}.`;
  const output = tail([result.stdout, result.stderr].filter((part) => part.trim()).join("\n"));
  return { ok: false, detail: output ? `${why}\n${output}` : why, exitCode: result.exitCode };
}

/** The lines a check adds above the routine's prompt when it wakes the chat. */
export function scheduledWorkCheckWakeText(
  command: string,
  check: { because: "changed" | "failed"; detail: string },
): string {
  const head = check.because === "failed"
    ? `(Check \`${command}\` failed. ADE will not wake you for it again until it passes.)`
    : `(Check \`${command}\` printed something new since the last run.)`;
  return `${head}\n\`\`\`\n${check.detail.replace(/```/g, "ˋˋˋ")}\n\`\`\``;
}
