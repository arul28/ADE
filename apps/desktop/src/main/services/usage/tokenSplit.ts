/**
 * Token-split rules shared by the live chat path (ACP telemetry, the per-turn
 * ledger) and the history scanners, so one provider row never normalizes two
 * different ways.
 */

/**
 * Uncached input from an input count that may include the cached part.
 * Providers that report cache reads inside `input` (Codex, xAI, Qwen, Copilot)
 * give `input >= cached`; when the cached part is larger than the input, the
 * input is already exclusive and is kept as it is.
 */
export function uncachedInputTokens(
  input: number,
  cacheRead: number | undefined,
  cacheWrite: number | undefined,
): number {
  const cached = (cacheRead ?? 0) + (cacheWrite ?? 0);
  return cached > input ? input : input - cached;
}

/**
 * Providers whose `done.usage.outputTokens` EXCLUDES reasoning, so the billable
 * output of a turn is `outputTokens + reasoningTokens`. Everywhere else the
 * reasoning count is a subset of the output count and is never priced again.
 *
 * | Provider | Reasoning in output? | Evidence |
 * | --- | --- | --- |
 * | OpenCode | No, apart | `buildOpenCodeDoneUsage` (openCodeTurnUsage.ts) sums `step.output` and `step.reasoning` from `step-finish` parts. OpenCode's own `getUsage` sets `output = outputTokens - reasoningTokens` and prices reasoning at the output rate; 6,808 of 14,137 local messages carry more reasoning than output. |
 * | Codex | Yes | localUsageLedgers.ts `scanCodexLogsOnce`: 46,398 `last_token_usage` records satisfy `total == input + output`, and none has `reasoning > output`. |
 * | Claude | Yes | shared/types/chat.ts `done.usage.thinkingTokens`: "Already counted inside outputTokens". |
 * | Droid | Yes | droidSdkEventMapper.ts `doneUsageFrom` maps SDK `thinkingTokens` to `reasoningTokens`; 535 local Droid sessions all have `thinkingTokens <= outputTokens` (largest ratio 0.83, GPT-5.5 XHigh). |
 * | Pi | Yes | piSdkEventMapper.ts reads `usage.reasoning`; pi-ai's `Usage.reasoning` is "a subset of `output`: `output` already includes these tokens". |
 * | Grok | Yes | fixtures/grok.live-turn.jsonl: the reply "OK" has `output_tokens` 24 with `reasoning_tokens` 23, and `totalTokens` 22442 = input 22418 + output 24. |
 * | Copilot | Yes | fixtures/copilot.model-probe.json: `outputTokens` 53 with `thoughtTokens` 47, and `totalTokens` 18626 = input 18573 + output 53. |
 * | Qwen | Yes | localUsageLedgers.historyScanners.test.ts Qwen row: `outputTokens` 110 with `thoughtsTokens` 89, and `totalTokens` 13143 = input 13033 + output 110. |
 * | Kimi | Yes | Kimi sends the same ACP `usage` block as Copilot (acpDialects/shared.ts `readAcpPromptUsage`); no live capture yet. |
 * | Cursor | Yes | Cursor's dashboard bills input, output, and cache only (cursorDashboardUsage.ts `parseEvent`); there is no reasoning line to add. |
 */
const REASONING_BILLED_SEPARATELY: ReadonlySet<string> = new Set(["opencode"]);

export function reasoningBilledSeparately(provider: string | null | undefined): boolean {
  return provider != null && REASONING_BILLED_SEPARATELY.has(provider.trim().toLowerCase());
}
