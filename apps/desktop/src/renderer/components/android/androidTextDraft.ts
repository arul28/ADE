import { logRendererDebugEvent } from "../../lib/debugLog";

/*
 * Text from the emulator for the person to keep or hand to the agent: the
 * crash pin's stack, the Logs group's lines.
 */

/**
 * A chat draft: one line that says what it is, then the text as a fenced
 * block. The fence is longer than any run of backticks in the text, so a log
 * line with a fence of its own cannot end the block early.
 */
export function androidTextDraft(intro: string, text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${intro}\n\n${fence}text\n${text}\n${fence}\n`;
}

/** The text on the clipboard, through the app (the web client has its own). */
export function copyAndroidText(text: string): void {
  void Promise.resolve(window.ade?.app?.writeClipboardText?.(text)).catch((cause: unknown) => {
    logRendererDebugEvent("android.copy_text_failed", { error: cause instanceof Error ? cause.message : String(cause) });
  });
}
