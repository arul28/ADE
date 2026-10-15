import React, { useState } from "react";
import { claudeSubagentWindowIneffective, type ProviderCompactionSettings } from "../../../../shared/compactionSettings";
import { providerSupportsManualCompact } from "../../../../shared/contextCompaction";
import { ModernRow, ModernRows } from "../primitives/SettingsModern";
import { showToast } from "../../app/toast/toastStore";

const FIELD_CLASS = "rounded border border-border bg-background px-2 py-1 text-xs";
const NUMBER_INPUT_CLASS = `w-28 ${FIELD_CLASS}`;

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
  return <ModernRows>
    {account ? <ModernRow title="This account" control={<select aria-label="Account compaction setting" disabled={saving} value={value ? "custom" : "inherit"}
      className={FIELD_CLASS}
      onChange={(event) => void save(event.target.value === "inherit" ? null : {})}>
      <option value="inherit">Same as provider default</option><option value="custom">Custom</option>
    </select>} /> : null}
    {(!account || value) ? <>
      {provider === "claude" ? <>
        <ModernRow title="Compact at" hint="Applies at the next query start." control={<select aria-label="Compact at" disabled={saving} value={settings.atTokens ?? "auto"}
          className={FIELD_CLASS}
          onChange={(event) => void save({ ...settings, atTokens: event.target.value === "auto" ? null : Number(event.target.value) })}>
          <option value="auto">Auto (default)</option>{Array.from({ length: 10 }, (_, i) => (i + 1) * 100_000).map((n) => <option key={n} value={n}>{n / 1000}k</option>)}
        </select>} />
        <ModernRow title="Subagents compact at" hint={claudeSubagentWindowIneffective(settings)
          ? "No effect: subagents can only compact earlier than the main chat. Pick a lower number, or raise Compact at."
          : "Subagents can only compact earlier than the main chat, never later. Applies at the next query start."} control={<select aria-label="Subagents compact at" disabled={saving} value={settings.subagentAtTokens ?? "auto"}
          className={FIELD_CLASS}
          onChange={(event) => void save({ ...settings, subagentAtTokens: event.target.value === "auto" ? null : Number(event.target.value) })}>
          <option value="auto">Auto (same as the main chat)</option>{Array.from({ length: 10 }, (_, i) => (i + 1) * 100_000).map((n) => <option key={n} value={n}>{n / 1000}k</option>)}
        </select>} />
      </> : provider === "codex" ? <ModernRow title="Compact at" hint="Token count, capped at the active model window. Empty is Auto." control={control("atTokens", "Compact at")} /> : <>
        <ModernRow title={provider === "opencode" ? "Compaction buffer" : "Reserve tokens"} control={control("reserveTokens", "Reserve tokens")} />
        <ModernRow title="Keep recent tokens" control={control("keepRecentTokens", "Keep recent tokens")} />
      </>}
      {provider === "claude" ? <ModernRow title="After the cache expires" hint="After an hour idle, or 5 minutes when the account uses the 5-minute cache." control={<select aria-label="After the cache expires" disabled={saving} value={settings.idleMode ?? "ask"}
        className={FIELD_CLASS}
        onChange={(event) => void save({ ...settings, idleMode: event.target.value as "ask" | "always" | "never" })}>
        <option value="ask">Ask (pill)</option><option value="always">Always compact first</option><option value="never">Never</option>
      </select>} /> : null}
    </> : null}
  </ModernRows>;
}
