import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  Code,
  MagnifyingGlass,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { cn } from "../ui/cn";
import { INPUT_CLS, INPUT_STYLE } from "./shared";
import {
  ADE_ACTION_SCHEMAS,
  findAdeActionSchema,
  type AdeActionParam,
  type AdeActionSchema,
} from "./adeActionSchemas";

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
  { label: "Lane id", value: "{{trigger.lane.id}}" },
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
  const [showJson, setShowJson] = useState(false);

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

  const schema = useMemo(
    () => findAdeActionSchema(value.domain, value.action),
    [value.domain, value.action],
  );

  return (
    <div className="space-y-3">
      <ActionPicker
        value={value}
        registry={registry}
        onChange={(next) => onChange({ ...value, domain: next.domain, action: next.action })}
      />

      {registryError ? (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          {registryError} You can still type a domain and action manually.
        </div>
      ) : null}

      {value.domain && value.action ? (
        <ActionParamsEditor
          schema={schema}
          value={value}
          onChange={onChange}
          showJson={showJson}
          onToggleJson={() => setShowJson((current) => !current)}
        />
      ) : (
        <div className="rounded-lg border border-white/[0.06] bg-black/15 px-3 py-3 text-[11px] text-[#93A4B8]">
          Pick a domain and action to fill in its parameters.
        </div>
      )}
    </div>
  );
}

// --- Domain + action picker (searchable combobox) ---

function ActionPicker({
  value,
  registry,
  onChange,
}: {
  value: AdeActionValue;
  registry: AdeActionRegistryEntry[];
  onChange: (next: { domain: string; action: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useClickOutside(wrapRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);

  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    const items: Array<{
      domain: string;
      action: string;
      label: string;
      description: string;
    }> = [];
    for (const entry of registry) {
      for (const action of entry.actions) {
        const schema = findAdeActionSchema(entry.domain, action.name);
        items.push({
          domain: entry.domain,
          action: action.name,
          label: schema?.label ?? action.name,
          description: schema?.description ?? action.description ?? "",
        });
      }
    }
    if (!query) return items.slice(0, 200);
    return items
      .filter((item) => {
        const haystack = `${item.domain} ${item.action} ${item.label} ${item.description}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, 200);
  }, [registry, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof matches>();
    for (const item of matches) {
      const list = map.get(item.domain) ?? [];
      list.push(item);
      map.set(item.domain, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [matches]);

  const currentSchema = findAdeActionSchema(value.domain, value.action);
  const currentLabel = currentSchema?.label ?? value.action;

  const summary = value.domain && value.action ? (
    <span className="flex items-center gap-2 truncate">
      <Code size={12} weight="bold" className="text-[#A78BFA]" />
      <span className="truncate text-[12px] font-semibold text-[#F5FAFF]">{currentLabel}</span>
      <span className="truncate text-[11px] text-[#93A4B8]">
        {value.domain}.{value.action}
      </span>
    </span>
  ) : (
    <span className="flex items-center gap-2 text-[12px] text-[#93A4B8]">
      <MagnifyingGlass size={12} weight="bold" />
      Search ADE actions…
    </span>
  );

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 transition-colors",
          open
            ? "border-[#A78BFA]/40 bg-[#1a1830]"
            : "border-white/[0.08] bg-black/20 hover:border-white/[0.16]",
        )}
      >
        {summary}
        <CaretDown
          size={11}
          weight="bold"
          className={cn("shrink-0 text-[#8FA1B8] transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 z-30 mt-1.5 max-h-[420px] overflow-hidden rounded-xl border border-white/[0.1] bg-[#0B121A] shadow-2xl">
          <div className="flex items-center gap-2 border-b border-white/[0.06] bg-[#101926] px-2.5 py-2">
            <MagnifyingGlass size={11} weight="bold" className="text-[#8FA1B8]" />
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by domain, action, or description"
              className="flex-1 bg-transparent text-[12px] text-[#F5FAFF] placeholder:text-[#7E8A9A] focus:outline-none"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="rounded p-0.5 text-[#8FA1B8] hover:text-[#F5FAFF]"
              >
                <X size={11} weight="bold" />
              </button>
            ) : null}
          </div>
          <div className="max-h-[360px] overflow-y-auto p-1">
            {grouped.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-[#7E8A9A]">
                No actions match "{search}".
              </div>
            ) : (
              grouped.map(([domain, items]) => (
                <div key={domain} className="mb-1">
                  <div className="px-2 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-[1.5px] text-[#5FA0E0]">
                    {domain}
                  </div>
                  {items.map((item) => {
                    const active = item.domain === value.domain && item.action === value.action;
                    return (
                      <button
                        key={`${item.domain}.${item.action}`}
                        type="button"
                        onClick={() => {
                          onChange({ domain: item.domain, action: item.action });
                          setOpen(false);
                          setSearch("");
                        }}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left",
                          active ? "bg-[#A78BFA]/15" : "hover:bg-white/[0.04]",
                        )}
                      >
                        <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#A78BFA]" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="text-[12px] font-medium text-[#F5FAFF]">{item.label}</span>
                            <span className="text-[10px] text-[#7E8A9A]">{item.action}</span>
                          </span>
                          {item.description ? (
                            <span className="mt-0.5 block text-[10.5px] leading-snug text-[#93A4B8]">
                              {item.description}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- Per-action parameter editor ---

function ActionParamsEditor({
  schema,
  value,
  onChange,
  showJson,
  onToggleJson,
}: {
  schema: AdeActionSchema | undefined;
  value: AdeActionValue;
  onChange: (next: AdeActionValue) => void;
  showJson: boolean;
  onToggleJson: () => void;
}) {
  const args = (value.args && typeof value.args === "object" && !Array.isArray(value.args))
    ? (value.args as Record<string, unknown>)
    : {};

  const setArg = (name: string, next: unknown) => {
    const nextArgs = { ...args };
    if (next === undefined || next === "" || next === null) {
      delete nextArgs[name];
    } else {
      nextArgs[name] = next;
    }
    onChange({
      ...value,
      args: Object.keys(nextArgs).length === 0 ? undefined : nextArgs,
    });
  };

  return (
    <div className="space-y-3">
      {schema && schema.params.length > 0 ? (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">
              <Sparkle size={10} weight="fill" className="text-[#A78BFA]" />
              Parameters
            </div>
            <button
              type="button"
              onClick={onToggleJson}
              className="text-[10px] text-[#7DD3FC] hover:text-[#F5FAFF]"
            >
              {showJson ? "Hide JSON" : "Edit raw JSON"}
            </button>
          </div>
          <div className="space-y-2">
            {schema.params.map((param) => (
              <ParamField
                key={param.name}
                param={param}
                value={args[param.name]}
                onChange={(next) => setArg(param.name, next)}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-white/[0.06] bg-black/15 px-3 py-2.5 text-[11px] text-[#93A4B8]">
          <span className="block text-[#D8E3F2]">
            {schema?.description ?? "No structured form for this action yet."}
          </span>
          <span className="mt-1 block text-[#7E8A9A]">Pass arguments as JSON below.</span>
        </div>
      )}

      <PlaceholderRow />

      {(showJson || !schema || schema.params.length === 0) ? (
        <JsonArgsEditor value={value} onChange={onChange} />
      ) : null}

      {schema ? (
        <div className="flex items-center gap-1.5 text-[10px] text-[#7E8A9A]">
          <ArrowSquareOut size={10} weight="bold" />
          Maps to <span className="font-mono text-[#9FB2C7]">ade {value.domain} {value.action}</span>
        </div>
      ) : null}
    </div>
  );
}

function ParamField({
  param,
  value,
  onChange,
}: {
  param: AdeActionParam;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const labelEl = (
    <div className="flex items-baseline justify-between">
      <span className="text-[10.5px] font-semibold text-[#D8E3F2]">
        {param.name}
        {param.required ? <span className="ml-0.5 text-[#F472B6]">*</span> : null}
      </span>
      {param.description ? (
        <span className="ml-2 truncate text-[10px] text-[#7E8A9A]" title={param.description}>
          {param.description}
        </span>
      ) : null}
    </div>
  );

  if (param.type === "boolean") {
    const checked = value === true;
    return (
      <label className="flex cursor-pointer items-center justify-between rounded-md border border-white/[0.06] bg-black/15 px-3 py-2 text-[11px] text-[#D8E3F2] hover:border-white/[0.12]">
        <span className="min-w-0 flex-1">
          <span className="block text-[10.5px] font-semibold text-[#D8E3F2]">
            {param.name}
            {param.required ? <span className="ml-0.5 text-[#F472B6]">*</span> : null}
          </span>
          {param.description ? (
            <span className="mt-0.5 block text-[10px] text-[#7E8A9A]">{param.description}</span>
          ) : null}
        </span>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => {
            // Required booleans must persist `false` so the server sees the
            // explicit choice; optional booleans can drop to "unset".
            if (event.target.checked) onChange(true);
            else onChange(param.required ? false : undefined);
          }}
          className="ml-2 h-3.5 w-3.5 accent-[#7DD3FC]"
        />
      </label>
    );
  }

  if (param.type === "enum" && param.enumValues) {
    const current = typeof value === "string" ? value : (param.defaultValue as string | undefined) ?? "";
    return (
      <label className="block space-y-1">
        {labelEl}
        <select
          className={INPUT_CLS}
          style={INPUT_STYLE}
          value={current}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          {!param.required ? <option value="">— unset —</option> : null}
          {param.enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (param.type === "number") {
    const current = typeof value === "number" ? String(value) : "";
    return (
      <label className="block space-y-1">
        {labelEl}
        <input
          type="number"
          className={INPUT_CLS}
          style={INPUT_STYLE}
          value={current}
          placeholder={param.placeholder ?? (param.defaultValue !== undefined ? String(param.defaultValue) : undefined)}
          onChange={(event) => {
            const raw = event.target.value.trim();
            if (!raw) return onChange(undefined);
            const parsed = Number(raw);
            onChange(Number.isFinite(parsed) ? parsed : undefined);
          }}
        />
      </label>
    );
  }

  if (param.type === "string-array") {
    const current = Array.isArray(value) ? (value as string[]).join(", ") : "";
    return (
      <label className="block space-y-1">
        {labelEl}
        <input
          className={INPUT_CLS}
          style={INPUT_STYLE}
          value={current}
          placeholder={param.placeholder ?? "comma, separated, list"}
          onChange={(event) => {
            const raw = event.target.value;
            if (!raw.trim()) return onChange(undefined);
            const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
            onChange(items.length > 0 ? items : undefined);
          }}
        />
      </label>
    );
  }

  if (param.type === "json") {
    const current = typeof value === "string"
      ? value
      : value === undefined
        ? ""
        : JSON.stringify(value, null, 2);
    return (
      <label className="block space-y-1">
        {labelEl}
        <textarea
          className="min-h-[60px] w-full rounded-md px-3 py-2 font-mono text-[11px] text-[#F5F7FA] placeholder:text-[#7E8A9A]"
          style={INPUT_STYLE}
          value={current}
          placeholder={param.placeholder ?? '{ "key": "value" }'}
          onChange={(event) => {
            const raw = event.target.value;
            if (!raw.trim()) return onChange(undefined);
            try {
              onChange(JSON.parse(raw));
            } catch {
              onChange(raw);
            }
          }}
        />
      </label>
    );
  }

  // string (default)
  const current = typeof value === "string" ? value : "";
  return (
    <label className="block space-y-1">
      {labelEl}
      <input
        className={INPUT_CLS}
        style={INPUT_STYLE}
        value={current}
        placeholder={param.placeholder ?? (param.defaultValue !== undefined ? String(param.defaultValue) : undefined)}
        onChange={(event) => onChange(event.target.value || undefined)}
      />
    </label>
  );
}

function PlaceholderRow() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (placeholder: string) => {
    try {
      await navigator.clipboard.writeText(placeholder);
      setCopied(placeholder);
      window.setTimeout(() => setCopied((current) => (current === placeholder ? null : current)), 1200);
    } catch {
      // Clipboard may be blocked (e.g., insecure context) — silently no-op.
    }
  };
  return (
    <details className="rounded-md border border-white/[0.06] bg-black/15 px-2.5 py-1.5 text-[10px]">
      <summary className="cursor-pointer text-[10px] uppercase tracking-[1px] text-[#8FA1B8] hover:text-[#D8E3F2]">
        Trigger variables — click to copy
      </summary>
      <div className="mt-2 flex flex-wrap gap-1">
        {TRIGGER_PLACEHOLDERS.map((placeholder) => (
          <button
            key={placeholder.value}
            type="button"
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px] transition-colors",
              copied === placeholder.value
                ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
                : "border-[#35506B] bg-[#0F1B2A] text-[#9FB2C7] hover:border-[#5FA0E0] hover:text-[#F5FAFF]",
            )}
            onClick={() => void copy(placeholder.value)}
            title={placeholder.value}
          >
            {copied === placeholder.value ? "✓ copied" : placeholder.label}
          </button>
        ))}
      </div>
    </details>
  );
}

function JsonArgsEditor({
  value,
  onChange,
}: {
  value: AdeActionValue;
  onChange: (next: AdeActionValue) => void;
}) {
  const [text, setText] = useState<string>(() => formatArgs(value.args));
  const [parseError, setParseError] = useState<string | null>(null);
  // When the user commits valid JSON we re-emit `value.args`, which would
  // otherwise re-fire the sync effect and reformat the textarea mid-keystroke
  // (clobbering the cursor). Skip the next sync after a self-emit.
  const skipNextSyncRef = useRef(false);

  useEffect(() => {
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      return;
    }
    setText(formatArgs(value.args));
    setParseError(null);
  }, [value.args]);

  const commit = (next: string) => {
    setText(next);
    if (!next.trim()) {
      setParseError(null);
      skipNextSyncRef.current = true;
      onChange({ ...value, args: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(next);
      setParseError(null);
      skipNextSyncRef.current = true;
      onChange({ ...value, args: parsed });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Raw arguments (JSON)</span>
        {parseError ? (
          <span className="text-[10px] text-amber-300">{parseError}</span>
        ) : null}
      </div>
      <textarea
        className="min-h-[80px] w-full rounded-md px-3 py-2 font-mono text-[11px] text-[#F5F7FA] placeholder:text-[#7E8A9A]"
        style={INPUT_STYLE}
        value={text}
        onChange={(event) => commit(event.target.value)}
        placeholder='{ "labels": ["triage"] }'
      />
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

// Surface schemas count for tests / debugging consumers.
export const ADE_ACTION_SCHEMA_COUNT = ADE_ACTION_SCHEMAS.length;
