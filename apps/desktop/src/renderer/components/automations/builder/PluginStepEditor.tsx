/**
 * The editor for a `plugin` workflow step: which installed plugin's action to
 * run, and the argument bag to run it with.
 *
 * Deliberately smaller than `AdeActionEditor`. That one browses a fixed
 * catalogue of hundreds of ADE actions and needs search, grouping and per-action
 * parameter schemas; a plugin declares at most twelve steps and describes each
 * one itself, so a single attributed select and a JSON bag is the whole surface.
 */

import { useEffect, useRef, useState } from "react";
import { Warning } from "@phosphor-icons/react";

import { cn } from "../../ui/cn";
import { labelCls, selectCls, textareaCls } from "../designTokens";
import { usePluginAutomationSteps, type PluginAutomationOption } from "../../plugins/usePluginRegistry";
import type { PluginStepValue } from "./draftBridge";

/**
 * The pair as one select value. `::` is an unambiguous separator: a plugin id
 * is `[a-z][a-z0-9-]*` and an action is a JS identifier, so neither can contain
 * a colon.
 */
function optionKey(pluginId: string, action: string): string {
  return `${pluginId}::${action}`;
}

function formatArgs(args: PluginStepValue["args"]): string {
  if (args === undefined || args === null) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "";
  }
}

/**
 * The argument bag, edited as JSON.
 *
 * Same self-emit guard `AdeActionEditor`'s JSON editor uses: committing valid
 * JSON re-emits `value.args`, which would otherwise re-run the sync effect and
 * reformat the textarea mid-keystroke, taking the cursor with it.
 */
function PluginStepArgs({
  value,
  onChange,
}: {
  value: PluginStepValue;
  onChange: (next: PluginStepValue) => void;
}) {
  const [text, setText] = useState<string>(() => formatArgs(value.args));
  const [parseError, setParseError] = useState<string | null>(null);
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
      const { args: _drop, ...rest } = value;
      onChange(rest);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(next);
      // An object only. `plugin.invoke` takes one argument bag, so a top-level
      // array or scalar would be a shape the invoke path cannot pass on.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setParseError("Arguments must be a JSON object");
        return;
      }
      setParseError(null);
      skipNextSyncRef.current = true;
      onChange({ ...value, args: parsed as Record<string, unknown> });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className={labelCls}>Arguments (JSON)</span>
        {parseError ? <span className="text-[10px] text-amber-300">{parseError}</span> : null}
      </div>
      <textarea
        className={cn(textareaCls, "min-h-[70px] font-mono text-[11px]")}
        value={text}
        onChange={(event) => commit(event.target.value)}
        placeholder='{ "issueId": "{{trigger.issue.number}}" }'
        spellCheck={false}
      />
      <span className="block text-[10px] text-muted-fg/60">
        {"{{trigger.*}}"} placeholders are filled in from the event before the plugin is called.
      </span>
    </div>
  );
}

export function PluginStepEditor({
  value,
  onChange,
}: {
  value: PluginStepValue;
  onChange: (next: PluginStepValue) => void;
}) {
  const options = usePluginAutomationSteps();
  const pluginId = (value.pluginId ?? "").trim();
  const action = (value.action ?? "").trim();
  const known = options.some((option) => option.pluginId === pluginId && option.value === action);
  // A step whose plugin is gone keeps its own option rather than snapping to
  // another plugin's: the rule is the user's authored content, uninstalling is
  // reversible, and rewriting the step here would silently point it somewhere
  // they never chose. The run refuses with a sentence naming the plugin.
  const orphan: PluginAutomationOption | null = !known && pluginId && action
    ? { pluginId, pluginName: pluginId, value: action, label: action }
    : null;
  const rendered = orphan ? [orphan, ...options] : options;
  const selected = rendered.find(
    (option) => option.pluginId === pluginId && option.value === action,
  );

  if (!rendered.length) {
    return (
      <p className="text-[11px] leading-relaxed text-muted-fg/70">
        No installed plugin offers an automation step yet. Install one from the Marketplace, then
        pick its action here.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      <label className="block space-y-1">
        <span className={labelCls}>Plugin action</span>
        <select
          className={selectCls}
          value={selected ? optionKey(pluginId, action) : ""}
          onChange={(event) => {
            const [nextPluginId = "", nextAction = ""] = event.target.value.split("::");
            onChange({ ...value, pluginId: nextPluginId, action: nextAction });
          }}
        >
          <option value="" disabled>
            Select a plugin action
          </option>
          {rendered.map((option) => (
            <option
              key={optionKey(option.pluginId, option.value)}
              value={optionKey(option.pluginId, option.value)}
            >
              {option.pluginName} — {option.label}
            </option>
          ))}
        </select>
      </label>

      {orphan ? (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          <Warning size={13} weight="regular" className="shrink-0" />
          <span className="min-w-0 flex-1 leading-relaxed">
            This machine doesn't have the {orphan.pluginId} plugin, so this step will fail. Install
            it from the Marketplace, or remove the step.
          </span>
        </div>
      ) : selected?.description ? (
        <p className="text-[11px] leading-relaxed text-muted-fg/70">{selected.description}</p>
      ) : null}

      <PluginStepArgs value={value} onChange={onChange} />
    </div>
  );
}
