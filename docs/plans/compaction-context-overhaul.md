# Compaction and context overhaul

Status: approved by the owner on 2026-10-09. Build in lane `ee07a22d` (branch `ade/4aba1063`).
Owner of the spec: the PM chat `8312dc6d`. The build agent reports back to it.

## Why

- ADE writes no compaction config for any provider. Every harness compacts at its own default.
- Claude on 1M models compacts very late. In the owner's last 7 days of Claude turns (`~/.ade/usage/turns-2026-10.jsonl`),
  77% of list-price cost came from turns with more than 400k tokens of context. ADE saw 24 compactions in 2,021 turns.
- A public replay (rohit3a, 2026-10-08) says a 400k `autoCompactWindow` saves about 29% of weekly usage.
- The context meter, the compaction divider and several failure paths have bugs (section 2).

## Research facts the build depends on

These are verified. Do not re-derive them; re-check only if the code disagrees.

1. **Claude Code `autoCompactWindow`** (CLI 2.1.284, SDK `sdk.d.ts` `Settings.autoCompactWindow?: number`).
   - Valid values: `auto`, or 100k to 1M. The CLI's own picker steps by 100k.
   - Precedence: env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` > settings > server "auto" value > model default.
   - The real threshold is `min(setting, model max window)`.
   - The CLI warns: "Overriding auto may result in high token usage, especially when resuming long sessions."
     So `auto` stays the default. The user opts in to a number.
   - `DISABLE_AUTO_COMPACT` / settings `autoCompactEnabled: false` turns auto-compaction off.
   - The SDK has an `apply_flag_settings` control request. Test whether it changes the window on a live query.
     If not, the new value applies at the next query start.
2. **Claude `getContextUsage()`** returns `raw_max_tokens` = the resolved **auto-compact window**, not the model maximum.
   `modelUsage[].contextWindow` on the result is the model maximum.
3. **Claude Code's own idle-resume rule** (CLI 2.1.284, dialog kind `resume_return`):
   idle ≥ `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` (default 70) and context ≥ `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`
   (default 100,000). Options: compact, continue, dismiss, never. ADE already renders this dialog
   (`agentChatService.ts` `CLAUDE_SUPPORTED_DIALOG_KINDS`, `shared/claudeCompaction.ts`). It is behind a
   server flag, so most sessions never get it.
4. **Prompt cache expiry, measured on the owner's data.** For Claude turns with >100k context, the share of the
   context re-written to cache on the first turn after an idle gap is:

   | Idle gap | Turns | Median cache write / context |
   |---|---|---|
   | < 55 min | 2,047 | 0.02–0.03 |
   | 55–65 min | 33 | 0.39 |
   | 65–120 min | 67 | 1.02 |
   | > 120 min | 128 | 1.85 |

   The cache lives 1 hour (`cacheWrite1hTokens` = all writes). After 60 minutes the next send re-writes the whole context.
5. **Cost of a resume after the cache expires (owner data, ≥60 min idle):**

   | Context before idle | Resumes | Avg cache write on resume | Avg resume-turn list cost |
   |---|---|---|---|
   | 100–200k | 38 | 190–280k | $6–21 |
   | 200–500k | 72 | 320–510k | $36–41 |
   | > 500k | 102 | 885k | $86 |

   Break-even: a cold resume costs about 2N (1h cache write) + 0.1N per later request. A compaction costs about
   N input + a ~6k-token summary. Compaction is cheaper for almost any N above ~30k. The limit is the quality loss of
   the summary, not cost. So the chip threshold is a quality choice: use **100k**, the value Anthropic tuned for
   Claude Code.
6. **t3code** (open source, HEAD ec80933a): a Claude "Auto-compact after" setting (100k–1M) passed as SDK
   `settings.autoCompactWindow`; a "compact first" chip at idle ≥70 min and ≥100k; compaction as its own queued turn;
   a divider with `before → after` tokens. It has no near-full warning and no Codex limit setting.

## 1. Context window numbers (fix the gaps)

1. **Claude window source.** `updateClaudeLiveContextUsage` (`agentChatService.ts` ~21096) overwrites
   `guardrail.maxTokens` with the registry window on every `message_start`. The SDK snapshot sets it to the
   auto-compact window. Keep two separate values:
   - `maxTokens`: the model maximum (`modelUsage[].contextWindow`, else registry).
   - `compactAtTokens`: the auto-compact window (`getContextUsage().raw_max_tokens`, else the configured setting, else `maxTokens`).
   The ring measures against `maxTokens`. The guardrail thresholds (80/90/97%) and the ADE fallback measure against `compactAtTokens`.
2. **Claude live usage counts output tokens; the done event does not.** Use one formula everywhere: the last request's
   input + cache read + cache creation. Output of the last request becomes input of the next one, so add it only if it
   matches what the SDK snapshot reports. Check against `getContextUsage({detail:"summary"})` and pick the formula that matches.
3. **Codex cumulative fallback.** `contextUsageModel.ts` ~105 falls back to thread-cumulative `total.inputTokens`
   when `last` is missing. Show "unknown" instead. Never show a cumulative number as occupancy.
4. **Cursor.** Every dynamic Cursor model gets a hard-coded 200K (`modelRegistry.ts` ~2567). Use the real window from
   the Cursor model catalog if the SDK exposes it, else from the preCompact hook's `context_window_size`, and cache it per model.
   Record `contextTokens` on Cursor done events from the last request, not the run total.
5. **OpenCode + Anthropic.** `openCodeInventory.ts` ~682 lets ADE's canonical window override models.dev
   `limit.context`. Verify against the installed models.dev data and the OpenCode server. Use the smaller value when they disagree.
6. **Odd 200K Opus rows.** 9 `claude-opus-5-5` turns in October recorded `contextWindow: 200000`. Find the cause
   (look at `modelUsage` keys and the model id with or without `[1m]`). Fix it if it is ADE's bug.

## 2. Bugs to fix

1. **Replayed error under a successful compaction.** Chat `350a8678`, turn `92343e27`: the `/compact` on the new
   account worked (481,636 → 6,225 tokens), then ADE emitted the previous turn's
   "Error during compaction: You've hit your weekly limit" text again, with `originTimestamp` 15:03:01.690
   (the earlier turn). Raw events: `/Users/admin/Projects/ADE/.ade/transcripts/350a8678-dc9d-48ff-8ad4-f6d854688628.chat.jsonl`.
   Find the path that replays it (account switch → resume) and drop assistant text whose `originTimestamp` is older
   than the current turn's start, or that matches an already-emitted message.
2. **A failed `/compact` typed by the user, or a failed natural auto-compaction, never closes its divider.** Only
   ADE-issued compactions have a failure path. On turn end (done/failed/interrupted), close every open compaction for
   that turn with `state:"failed"` and a `failReason`. Add `failReason: "provider_error" | "quota"` and carry the provider's error text as `failDetail`.
3. **A failed compaction freezes the meter.** `contextUsageModel.ts` ~255 treats `failed` like `completed`. A failed
   compaction leaves usage unchanged: keep the last measured value.
4. **Typed `/compact` is labelled `auto` at start.** Claude: the `status:"compacting"` start uses `trigger:"auto"`.
   When the turn's user message is `/compact`, use `manual`. Codex: set `manualCompactionPending` before the
   `thread/compact/start` request, not after it resolves. ACP (`acpTurnTelemetry.ts` ~247): same rule.
5. **OpenCode `session.compaction.failed`** emits only a notice. Also emit `context_compact` with `state:"failed"`.
6. **Pi `compaction_end`** is always `completed`. Read its abort/error fields and map them. Remove the duplicate
   "Pi context compaction completed." notice on manual `/compact`.
7. **Quota failure during compaction.** The first `/compact` failed on account `1028` with a weekly limit. ADE showed a
   "session limit" card and scheduled an auto-"continue" for 6:01 AM. Fix all three:
   - Say "weekly limit" when the provider says weekly.
   - If another account is available (smart balance), move the chat and retry the compaction there at once, as one turn.
   - Never schedule a "continue" for a turn that was only a compaction. If nothing can run it, show the failed divider and stop.
8. **Idle-path `compact_boundary`** (`agentChatService.ts` ~26716) does not call the identity re-injection that the
   streamed path calls (~28118). Share one handler for both paths.
9. **Codex `/compact <instructions>`** drops the instructions silently. Pass them if `thread/compact/start` accepts
   them; otherwise tell the user in a notice that Codex ignores them.
10. **Docs drift.** `docs/ARCHITECTURE.md` ~1089 lists `ai/compactionEngine.ts`, which does not exist.

## 3. Auto-compact setting, per provider and per account

Put it on each provider's page in Settings → Providers (`settings/providers/ProviderDetailPage.tsx`). If the provider
has more than one account, show the setting on each account card (`providers/accounts/ProviderAccountsPanel`),
with "Same as provider default" as the first option.

| Provider | Control | How ADE applies it |
|---|---|---|
| Claude | "Auto-compact at": Auto (recommended), 100k … 1M in 100k steps; plus an "Off" switch | SDK query `settings: { autoCompactWindow }`; Off → `autoCompactEnabled: false`. Never write the user's `~/.claude/settings.json`. Do not set the env var (it would override a user's own `/autocompact`). |
| Codex | "Auto-compact at": Default, or a token count up to the model window | app-server launch config override `model_auto_compact_token_limit` (`-c` flag or the config the app-server accepts). Verify the key name against the installed codex version. |
| OpenCode | "Auto-compact": on/off, and any threshold the installed OpenCode config schema supports | OpenCode config `compaction.*`. Verify the schema in the installed OpenCode package. |
| Pi | Whatever the Pi SDK settings expose (likely `compaction.enabled`, `reserveTokens`, `keepRecentTokens`) | Verify in the Pi SDK. |
| Cursor, Droid, ACP agents | No control. Show one line: "This provider compacts by itself. ADE cannot change when." | — |

Rules:
- Resolution: chat override (later, not now) > account setting > provider setting > harness default.
- The setting syncs like other provider settings (desktop, web client, phone read the same value). Check the
  runtime-backed service path, not only the local Electron path.
- A change applies at the next query start. If `apply_flag_settings` works live for Claude, apply it at once.
- The meter shows the compaction point (section 4).
- Per-account storage: use the existing account record (instance id), not the account's config directory.

## 4. Compaction look and feel

### 4a. The divider in the thread

Replace the current `ContextCompactDivider.tsx` design. One centered divider row:

- **Running:** a thin line with a soft shimmer, a small compress icon, and "Compacting context · 481k tokens".
  Show elapsed seconds after 5 s.
- **Done:** "Context compacted · 481k → 6k · 28 s". Add the trigger as quiet text: "you asked", "automatic",
  "ADE (near limit)". Add "2nd this chat" from `sessionCompactionCount` when it is 2 or more.
- **Failed:** the same row in the warning tone: "Compaction failed · weekly limit on 1028". One action if useful:
  "Retry" (sends `/compact`) or "Switch account".
- Click the done row to expand the summary text if the provider gives one (OpenCode gives it; Claude's summary is the
  first user message after the boundary; show it if it can be read without new provider calls).
- Keep it quiet: no card, no border box, the same height as other dividers. Match the theme tokens. Use the
  `frontend-design` guidance for the visual pass.
- Mirror the same states on iOS (`WorkContextCompactDivider`) and the web client. Keep the copy identical.

### 4b. Sidebar and Work row state

- Add `compacting` to the chat activity states. The Work row and the sidebar show "Compacting…" with the token count
  while it runs, the same way they show "Thinking" or "Testing".
- When it ends, the row goes back to its normal state. A failed compaction shows as a warning on the row until the next turn.
- Phone and web read the same activity value.

### 4c. The context meter

- Ring measures against the model maximum. A small tick on the ring marks the compaction point (`compactAtTokens`).
- Popover: "312k of 1M used · compacts at 400k", the source of the compaction point ("your setting", "Claude default"),
  a "Compact now" button (claude, codex, pi, and opencode if its server lists `compact`), and a link to the provider setting.
- After a compaction, the ring drops at once to `postTokens`.

## 5. "Compact first" after idle

- **When:** provider is Claude, the chat has been idle **60 minutes or more** since its last turn ended (the prompt cache
  has expired, see fact 4), and the last measured context is **100,000 tokens or more** (fact 5).
- **Where:** a small pill in the composer footer, to the left of the context meter. No banner, no transcript row, no dialog.
  Text: "Compact first · 412k". Tooltip: "The cache expired after an hour. Compacting first re-sends about 6k tokens instead of 412k."
  (Use the real numbers; estimate the post size as ~2% of context or the last `postTokens` for this chat.)
- **Default:** the pill shows but is **off**. Click to turn it on for the next send. With it on, Enter runs `/compact`
  as its own turn, then sends the message behind it.
- **Setting:** on the Claude provider page (and per account): "After an hour idle: Ask (pill) / Always compact first / Never".
  "Always" turns the pill on by default; "Never" hides it.
- If Claude's own `resume_return` dialog appears, do not also show the pill for that send.
- Codex and others: no pill in this round. Their cache rules differ.

## 6. Docs

Update in the same change:
- `docs/features/chat/transcript-and-turns.md` (compaction events, divider states, failure reasons).
- `docs/features/chat/composer-and-ui.md` (meter, pill).
- `docs/features/chat/agent-routing.md` (per-provider compaction table: native auto-compact, ADE control, `/compact`).
- A user-facing page in the repo-root Mintlify docs for the setting and the pill.
- Fix `docs/ARCHITECTURE.md` drift.

## 7. Out of scope now

- A per-chat override of the window.
- A Codex or OpenCode "compact first" pill.
- Live runs and proof captures. The owner tests by hand later, when Claude usage is back.

## Failure modes to note for `/test` (do not write tests during the build)

- The ring jumps between two windows on one Claude chat.
- A compaction divider still spins after its turn ended.
- A failed compaction changes the meter.
- A successful compaction shows an error under it.
- A compaction-only turn schedules a "continue".
- The account setting is ignored when the chat moves accounts.
- The pill appears below 100k, before 60 minutes, or for a non-Claude chat.
- The setting does not reach a chat run by the runtime brain (remote viewer, phone).
