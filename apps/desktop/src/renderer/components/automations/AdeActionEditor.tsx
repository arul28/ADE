import { useEffect, useMemo, useState } from "react";
import { cn } from "../ui/cn";
import { INPUT_CLS, INPUT_STYLE } from "./shared";

export type AdeActionRegistryEntry = {
  domain: string;
  actions: Array<{ name: string; description?: string }>;
};

export type AdeActionValue = {
  domain: string;
  action: string;
  args?: Record<string, unknown> | unknown[];
  resolvers?: Record<string, string>;
};

type AdeActionsApi = {
  listRegistry?: () => Promise<AdeActionRegistryEntry[]>;
};

function getActionsApi(): AdeActionsApi {
  return (window as unknown as { ade: { actions?: AdeActionsApi } }).ade.actions ?? {};
}

const TRIGGER_PLACEHOLDERS: Array<{ label: string; value: string }> = [
  { label: "Issue #", value: "{{trigger.issue.number}}" },
  { label: "Issue title", value: "{{trigger.issue.title}}" },
  { label: "Issue author", value: "{{trigger.issue.author}}" },
  { label: "Issue labels", value: "{{trigger.issue.labels}}" },
  { label: "PR #", value: "{{trigger.pr.number}}" },
  { label: "PR title", value: "{{trigger.pr.title}}" },
  { label: "PR author", value: "{{trigger.pr.author}}" },
  { label: "Branch", value: "{{trigger.branch}}" },
];

export function AdeActionEditor({
  value,
  onChange,
}: {
  value: AdeActionValue;
  onChange: (next: AdeActionValue) => void;
}) {
  const [registry, setRegistry] = useState<AdeActionRegistryEntry[]>([]);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [argsText, setArgsText] = useState<string>(() => formatArgs(value.args));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const api = getActionsApi();
      if (!api.listRegistry) {
        setRegistryError("Action registry bridge unavailable.");
        return;
      }
      try {
        const next = await api.listRegistry();
        if (!cancelled) setRegistry(next);
      } catch (err) {
        if (!cancelled) setRegistryError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setArgsText(formatArgs(value.args));
  }, [value.args]);

  const domainEntry = useMemo(
    () => registry.find((entry) => entry.domain === value.domain),
    [registry, value.domain],
  );

  const commitArgs = (text: string) => {
    setArgsText(text);
    if (!text.trim()) {
      onChange({ ...value, args: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      onChange({ ...value, args: parsed });
    } catch {
      // Leave args un-updated until the JSON parses; the UI shows raw text.
    }
  };

  const insertPlaceholder = (placeholder: string) => {
    try {
      const parsed = argsText.trim().length ? JSON.parse(argsText) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        commitArgs(JSON.stringify({ ...parsed, field: placeholder }, null, 2));
        return;
      }
    } catch {
      // Keep the user's invalid JSON untouched until they correct it.
      return;
    }
    commitArgs(`{\n  "field": "${placeholder}"\n}`);
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-2">
        <label className="space-y-1 block">
          <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Domain</span>
          <select
            className={INPUT_CLS}
            style={INPUT_STYLE}
            value={value.domain}
            onChange={(event) =>
              onChange({ ...value, domain: event.target.value, action: "" })
            }
          >
            <option value="">Select domain…</option>
            {registry.map((entry) => (
              <option key={entry.domain} value={entry.domain}>
                {entry.domain}
              </option>
            ))}
            {value.domain && !registry.some((entry) => entry.domain === value.domain) ? (
              <option value={value.domain}>{value.domain}</option>
            ) : null}
          </select>
        </label>

        <label className="space-y-1 block">
          <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Action</span>
          <select
            className={INPUT_CLS}
            style={INPUT_STYLE}
            value={value.action}
            onChange={(event) => onChange({ ...value, action: event.target.value })}
            disabled={!value.domain}
          >
            <option value="">Select action…</option>
            {domainEntry?.actions.map((action) => (
              <option key={action.name} value={action.name}>
                {action.name}
              </option>
            ))}
            {value.action && !domainEntry?.actions.some((action) => action.name === value.action) ? (
              <option value={value.action}>{value.action}</option>
            ) : null}
          </select>
        </label>
      </div>

      {registryError ? (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          {registryError} Picker will show free-text only; you can still save with a manual domain/action.
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Arguments (JSON)</span>
          <div className="flex flex-wrap gap-1">
            {TRIGGER_PLACEHOLDERS.map((placeholder) => (
              <button
                key={placeholder.value}
                type="button"
                className="rounded border border-[#35506B] bg-[#0F1B2A] px-1.5 py-0.5 text-[10px] text-[#9FB2C7] hover:border-[#5FA0E0] hover:text-[#F5FAFF]"
                onClick={() => insertPlaceholder(placeholder.value)}
                title={placeholder.value}
              >
                {placeholder.label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          className={cn(
            "min-h-[96px] w-full rounded-md px-3 py-2 font-mono text-[11px] text-[#F5F7FA] placeholder:text-[#7E8A9A]",
          )}
          style={INPUT_STYLE}
          value={argsText}
          onChange={(event) => commitArgs(event.target.value)}
          placeholder='{ "labels": ["triage"] }'
        />
      </div>
    </div>
  );
}

function formatArgs(args: AdeActionValue["args"]): string {
  if (args === undefined || args === null) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "";
  }
}
