import React from "react";
import { cn } from "../../ui/cn";

type ProviderSelectorProps = {
  provider: "claude" | "codex";
  onProviderChange: (provider: "claude" | "codex") => void;
  claudePermissionMode?: string;
  onClaudePermissionModeChange?: (mode: string) => void;
  codexApprovalMode?: string;
  onCodexApprovalModeChange?: (mode: string) => void;
};

const claudePermissionOptions = [
  { value: "bypass", label: "Bypass permissions" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "manual", label: "Manual" }
];

const codexApprovalOptions = [
  { value: "fullAuto", label: "Full auto" },
  { value: "autoEdit", label: "Auto edit" },
  { value: "suggest", label: "Suggest" },
  { value: "manual", label: "Manual" }
];

export function ProviderSelector({
  provider,
  onProviderChange,
  claudePermissionMode,
  onClaudePermissionModeChange,
  codexApprovalMode,
  onCodexApprovalModeChange
}: ProviderSelectorProps) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(["claude", "codex"] as const).map((p) => (
          <button
            key={p}
            onClick={() => onProviderChange(p)}
            className={cn(
              "flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
              provider === p
                ? "border-accent ring-2 ring-accent bg-accent/10 text-accent"
                : "border-border bg-card text-fg hover:bg-muted/50"
            )}
          >
            {p === "claude" ? "Claude Code" : "Codex"}
          </button>
        ))}
      </div>

      {provider === "claude" && onClaudePermissionModeChange && (
        <div>
          <label className="mb-1 block text-xs font-medium text-fg">Permission Mode</label>
          <select
            value={claudePermissionMode ?? "bypass"}
            onChange={(e) => onClaudePermissionModeChange(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {claudePermissionOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {provider === "codex" && onCodexApprovalModeChange && (
        <div>
          <label className="mb-1 block text-xs font-medium text-fg">Approval Mode</label>
          <select
            value={codexApprovalMode ?? "fullAuto"}
            onChange={(e) => onCodexApprovalModeChange(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {codexApprovalOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
