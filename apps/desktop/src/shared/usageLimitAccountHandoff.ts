/**
 * The prompt a new chat receives when a usage-limited chat continues on
 * another account. The provider thread cannot move — it lives in the account
 * that started it — so the continuation is a new chat with the task in hand.
 */

const HANDOFF_FIELD_MAX_CHARS = 4_000;

function clip(value: string | null | undefined, max = HANDOFF_FIELD_MAX_CHARS): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export function usageLimitHandoffPrompt(input: {
  accountLabel: string;
  title?: string | null;
  task?: string | null;
  summary?: string | null;
}): string {
  const label = input.accountLabel.trim() || "other";
  const lines = [
    `Continue the interrupted task on the ${label} account. The previous chat hit a usage limit. Do not restart work that already completed.`,
  ];
  const title = clip(input.title, 200);
  const task = clip(input.task);
  const summary = clip(input.summary);
  if (title) lines.push("", `Title: ${title}`);
  if (task) lines.push("", `Task: ${task}`);
  if (summary) lines.push("", `Where it stopped: ${summary}`);
  return lines.join("\n");
}
