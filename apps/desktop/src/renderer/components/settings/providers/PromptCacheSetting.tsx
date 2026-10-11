import React, { useState } from "react";
import { ModernRow, ModernRows } from "../primitives/SettingsModern";
import { showToast } from "../../app/toast/toastStore";

const FIELD_CLASS = "rounded border border-border bg-background px-2 py-1 text-xs";

/**
 * One Claude account's prompt cache TTL for subagents, workflows and helper
 * requests. "Default" stores nothing, so Claude Code decides.
 */
export function PromptCacheSetting({ value, onChange }: {
  value?: "1h";
  onChange: (value: "1h" | null) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const save = async (next: "1h" | null) => {
    setSaving(true);
    try { await onChange(next); }
    catch (error) { showToast({ tone: "error", title: "Could not save prompt cache setting", message: error instanceof Error ? error.message : String(error) }); }
    finally { setSaving(false); }
  };
  return <ModernRows>
    <ModernRow title="Subagent prompt cache"
      hint="1 hour costs more per cache write. Applies to new sessions."
      control={<select aria-label="Subagent prompt cache" disabled={saving} value={value ?? "default"}
        className={FIELD_CLASS}
        onChange={(event) => void save(event.target.value === "1h" ? "1h" : null)}>
        <option value="default">5 minutes (default)</option><option value="1h">1 hour</option>
      </select>} />
  </ModernRows>;
}
