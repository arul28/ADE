import React, { useState } from "react";
import { claudeSubagentWindowIneffective, compactionIdleModeDefault, type ProviderCompactionSettings } from "../../../../shared/compactionSettings";
import { providerSupportsManualCompact } from "../../../../shared/contextCompaction";
import { ModernRow, ModernRows } from "../primitives/SettingsModern";
import { showToast } from "../../app/toast/toastStore";

const FIELD_CLASS = "rounded border border-border bg-background px-2 py-1 text-xs";
const NUMBER_INPUT_CLASS = `w-28 ${FIELD_CLASS}`;
/** Claude's compaction windows, in the 100k steps it accepts. */
const CLAUDE_WINDOW_STEPS = Array.from({ length: 10 }, (_, i) => (i + 1) * 100_000);

/** Providers whose `/compact` ADE can run, so the idle offer can exist for them. */
const COMPACT_FIRST_PROVIDERS = new Set(["claude", "codex", "pi", "opencode"]);

/**
 * The window the pill waits out, named per provider from each vendor's own
 * documented prompt-cache lifetime. Claude's is measured per chat instead of
 * assumed (`shared/claudePromptCache.ts`).
 */
function compactFirstIdleHint(provider: string): string {
  switch (provider) {
    case "claude":
      return "After an hour idle, or 5 minutes when the account uses the 5-minute cache. In Always, ADE also compacts a large chat 54 minutes in, while the cache is still warm.";
    case "codex":
      return "OpenAI's prompt cache lasts 30 minutes, so the pill offers to compact a large chat once it has been idle that long. Nothing runs on its own.";
    default:
      return "The window follows the model's vendor: 30 minutes on OpenAI models, an hour on Claude's. The pill only offers after that, and nothing runs on its own.";
  }
}

/**
 * Reads a token-count field on blur. An empty field means "use the default"
 * (undefined). Anything that is not a positive safe integer within `max` is
 * "invalid" and must not be saved.
 */
function parsePositiveTokenInput(raw: string, max?: number): number | undefined | "invalid" {
  if (raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0 || (max !== undefined && n > max)) return "invalid";
  return n;
}

export function CompactionSettings({ provider, value, account = false, onChange }: {
  provider: string;
  value?: ProviderCompactionSettings;
  account?: boolean;
  onChange: (value: ProviderCompactionSettings | null) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const supported = providerSupportsManualCompact(provider);
  const save = async (next: ProviderCompactionSettings | null) => {
    setSaving(true);
    try { await onChange(next); }
    catch (error) { showToast({ tone: "error", title: "Could not save compaction setting", message: error instanceof Error ? error.message : String(error) }); }
    finally { setSaving(false); }
  };
  if (!supported) return <p className="text-xs text-muted-fg">This provider compacts by itself. ADE cannot change when.</p>;
  const settings = value ?? {};
  const control = (key: "atTokens" | "reserveTokens" | "keepRecentTokens", label: string, max?: number) => (
    <input aria-label={label} type="number" min={1} max={max} disabled={saving} key={settings[key] ?? "default"} defaultValue={settings[key] ?? ""} placeholder={key === "atTokens" ? "Auto" : "Default"}
      className={NUMBER_INPUT_CLASS}
      onBlur={(event) => {
        const parsed = parsePositiveTokenInput(event.target.value, max);
        if (parsed === "invalid") {
          // Put the saved value back and say why, instead of keeping text that was never saved.
          event.target.value = settings[key] != null ? String(settings[key]) : "";
          showToast({ tone: "warning", title: `${label}: enter a whole number above 0${max ? `, at most ${max.toLocaleString("en-US")}` : ""}.` });
          return;
        }
        void save({ ...settings, [key]: parsed });
      }} />
  );
  const windowSelect = (key: "atTokens" | "subagentAtTokens", label: string, autoLabel: string) => (
    <select aria-label={label} disabled={saving} value={settings[key] ?? "auto"}
      className={FIELD_CLASS}
      onChange={(event) => void save({ ...settings, [key]: event.target.value === "auto" ? null : Number(event.target.value) })}>
      <option value="auto">{autoLabel}</option>{CLAUDE_WINDOW_STEPS.map((n) => <option key={n} value={n}>{n / 1000}k</option>)}
    </select>
  );
  return <ModernRows>
    {account ? <ModernRow title="This account" control={<select aria-label="Account compaction setting" disabled={saving} value={value ? "custom" : "inherit"}
      className={FIELD_CLASS}
      onChange={(event) => void save(event.target.value === "inherit" ? null : {})}>
      <option value="inherit">Same as provider default</option><option value="custom">Custom</option>
    </select>} /> : null}
    {(!account || value) ? <>
      {provider === "claude" ? <>
        <ModernRow title="Compact at" hint="Applies at the next query start." control={windowSelect("atTokens", "Compact at", "Auto (default)")} />
        <ModernRow title="Subagents compact at" hint={claudeSubagentWindowIneffective(settings)
          ? "No effect: subagents can only compact earlier than the main chat. Pick a lower number, or raise Compact at."
          : "Subagents can only compact earlier than the main chat, never later. Applies at the next query start."}
          control={windowSelect("subagentAtTokens", "Subagents compact at", "Auto (same as the main chat)")} />
      </> : provider === "codex" || provider === "copilot" ? <ModernRow title="Compact at" hint="Token count, capped at the active model window. Empty is Auto." control={control("atTokens", "Compact at")} /> : <>
        <ModernRow title={provider === "opencode" ? "Compaction buffer" : "Reserve tokens"} control={control("reserveTokens", "Reserve tokens")} />
        <ModernRow title="Keep recent tokens" control={control("keepRecentTokens", "Keep recent tokens")} />
      </>}
      {COMPACT_FIRST_PROVIDERS.has(provider) ? <ModernRow title="After the cache expires"
        hint={compactFirstIdleHint(provider)}
        control={<select aria-label="After the cache expires" disabled={saving} value={settings.idleMode ?? compactionIdleModeDefault(provider)}
          className={FIELD_CLASS}
          onChange={(event) => void save({ ...settings, idleMode: event.target.value as "ask" | "always" | "never" })}>
          <option value="ask">Ask (pill)</option>
          <option value="always">{provider === "claude" ? "Always compact first" : "On by default"}</option>
          <option value="never">Never</option>
        </select>} /> : null}
    </> : null}
  </ModernRows>;
}
