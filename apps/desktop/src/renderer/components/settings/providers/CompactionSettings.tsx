import React, { useState } from "react";
import type { ProviderCompactionSettings } from "../../../../shared/compactionSettings";
import { ModernRow, ModernRows } from "../primitives/SettingsModern";
import { SettingsToggle } from "../primitives/SettingsControls";
import { showToast } from "../../app/toast/toastStore";

export function CompactionSettings({ provider, value, account = false, onChange }: {
  provider: string;
  value?: ProviderCompactionSettings;
  account?: boolean;
  onChange: (value: ProviderCompactionSettings | null) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const supported = ["claude", "codex", "opencode", "pi"].includes(provider);
  const save = async (next: ProviderCompactionSettings | null) => {
    setSaving(true);
    try { await onChange(next); }
    catch (error) { showToast({ tone: "error", title: "Could not save compaction setting", message: error instanceof Error ? error.message : String(error) }); }
    finally { setSaving(false); }
  };
  if (!supported) return <p className="text-xs text-muted-fg">This provider compacts by itself. ADE cannot change when.</p>;
  const settings = value ?? {};
  const control = (key: "atTokens" | "reserveTokens" | "keepRecentTokens", label: string, max?: number) => (
    <input aria-label={label} type="number" min={1} max={max} disabled={saving} key={settings[key] ?? "default"} defaultValue={settings[key] ?? ""} placeholder="Default"
      className="w-28 rounded border border-border bg-background px-2 py-1 text-xs"
      onBlur={(event) => { const n = Number(event.target.value); if (event.target.value && (!Number.isSafeInteger(n) || n <= 0 || (max && n > max))) return; void save({ ...settings, [key]: event.target.value ? n : undefined }); }} />
  );
  return <ModernRows>
    {account ? <ModernRow title="Auto-compact" control={<select aria-label="Account compaction setting" disabled={saving} value={value ? "custom" : "inherit"}
      className="rounded border border-border bg-background px-2 py-1 text-xs"
      onChange={(event) => void save(event.target.value === "inherit" ? null : {})}>
      <option value="inherit">Same as provider default</option><option value="custom">Custom</option>
    </select>} /> : null}
    {(!account || value) ? <>
      {provider !== "codex" ? <ModernRow title="Auto-compact" control={<SettingsToggle label="Auto-compact" checked={settings.enabled !== false} onChange={(enabled) => void save({ ...settings, enabled })} />} /> : null}
      {provider === "claude" ? <ModernRow title="Auto-compact at" hint="Applies at the next query start." control={<select aria-label="Auto-compact at" disabled={saving} value={settings.atTokens ?? "auto"}
        className="rounded border border-border bg-background px-2 py-1 text-xs"
        onChange={(event) => void save({ ...settings, atTokens: event.target.value === "auto" ? null : Number(event.target.value) })}>
        <option value="auto">Auto (recommended)</option>{Array.from({ length: 10 }, (_, i) => (i + 1) * 100_000).map((n) => <option key={n} value={n}>{n / 1000}k</option>)}
      </select>} /> : provider === "codex" ? <ModernRow title="Auto-compact at" hint="Token count, capped at the active model window." control={control("atTokens", "Auto-compact at")} /> : <>
        <ModernRow title={provider === "opencode" ? "Compaction buffer" : "Reserve tokens"} control={control("reserveTokens", "Reserve tokens")} />
        <ModernRow title="Keep recent tokens" control={control("keepRecentTokens", "Keep recent tokens")} />
      </>}
      {provider === "claude" ? <ModernRow title="After an hour idle" control={<select aria-label="After an hour idle" disabled={saving} value={settings.idleMode ?? "ask"}
        className="rounded border border-border bg-background px-2 py-1 text-xs"
        onChange={(event) => void save({ ...settings, idleMode: event.target.value as "ask" | "always" | "never" })}>
        <option value="ask">Ask (pill)</option><option value="always">Always compact first</option><option value="never">Never</option>
      </select>} /> : null}
    </> : null}
  </ModernRows>;
}
