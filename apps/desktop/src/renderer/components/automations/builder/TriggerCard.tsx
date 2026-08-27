import { useState } from "react";
import { Warning } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type {
  AutomationIngressDelivery,
  AutomationIngressStatus,
  AutomationTrigger,
  AutomationTriggerDeliveryStatus,
} from "../../../../shared/types";
import { triggerDeliveryKeyForType } from "../../../../shared/types";
import { linearIngressApi } from "../linearIngressApi";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { inputCls, labelCls, recessedCls, selectCls } from "../designTokens";
import {
  accentTint,
  defaultTriggerForSource,
  eventLabel,
  sourceDef,
  sourceForTriggerType,
  TRIGGER_SOURCES,
  type TriggerSource,
} from "../triggerCatalog";
import { usePluginAutomationTriggers, type PluginAutomationOption } from "../../plugins/usePluginRegistry";
import { useBuiltinSurfaceVisible } from "../../plugins/useBuiltinTabs";
import { GitHubTriggerFilters } from "../GitHubTriggerFilters";
import { LinearTriggerFilters } from "../LinearTriggerFilters";
import { ScheduleEditor } from "./ScheduleEditor";
import { settingsRouteFor } from "../../settings/settingsManifest";

function SmallField({
  label,
  value,
  placeholder,
  mono,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className={labelCls}>{label}</span>
      <input
        className={cn(inputCls, mono && "font-mono")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
    </label>
  );
}

function CalloutActionButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="ml-auto shrink-0 text-amber-100"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

function TriggerDeliveryCallout({
  deliveryKey,
  status,
  onIngressChanged,
}: {
  deliveryKey: keyof AutomationIngressDelivery;
  status: AutomationTriggerDeliveryStatus;
  onIngressChanged?: () => void;
}) {
  const navigate = useNavigate();
  const [linearPending, setLinearPending] = useState(false);
  const linearApi = linearIngressApi();

  const setupLinear = async () => {
    if (!linearApi?.setup) return;
    setLinearPending(true);
    try {
      await linearApi.setup();
    } catch {
      // The ingress service records the setup error for the next refresh.
    } finally {
      setLinearPending(false);
      onIngressChanged?.();
    }
  };

  let action = null;
  if (deliveryKey === "github" || deliveryKey === "githubWebhook") {
    action = (
      <CalloutActionButton label="Open GitHub settings" onClick={() => navigate(settingsRouteFor("integrations.github"))} />
    );
  } else if (deliveryKey === "linear") {
    action = linearApi?.setup ? (
      <CalloutActionButton label="Connect Linear" disabled={linearPending} onClick={() => void setupLinear()} />
    ) : (
      <CalloutActionButton label="Open Linear settings" onClick={() => navigate(settingsRouteFor("integrations.linear"))} />
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
      <Warning size={13} weight="regular" className="shrink-0" />
      <span className="min-w-0 flex-1 leading-relaxed">
        {status.setupError ?? "Events for this trigger can't be delivered yet."}
      </span>
      {action}
    </div>
  );
}

function TriggerFilters({
  trigger,
  source,
  onPatch,
}: {
  trigger: AutomationTrigger;
  source: TriggerSource;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  if (trigger.type === "schedule") return <ScheduleEditor trigger={trigger} onPatch={onPatch} />;
  if (source === "github") return <GitHubTriggerFilters trigger={trigger} onPatch={onPatch} />;
  if (source === "linear") return <LinearTriggerFilters trigger={trigger} onPatch={onPatch} />;
  if (source === "git") {
    return (
      <SmallField
        label="Branch"
        value={trigger.branch ?? ""}
        placeholder="main"
        onChange={(v) => onPatch({ branch: v })}
      />
    );
  }
  if (source === "file") {
    return (
      <SmallField
        label="Paths (comma-separated globs)"
        value={(trigger.paths ?? []).join(", ")}
        placeholder="src/**, apps/**"
        mono
        onChange={(v) => onPatch({ paths: v.split(",").map((p) => p.trim()).filter(Boolean) })}
      />
    );
  }
  if (source === "lane") {
    return (
      <SmallField
        label="Lane name pattern (optional)"
        value={trigger.namePattern ?? ""}
        placeholder="feature/*"
        mono
        onChange={(v) => onPatch({ namePattern: v })}
      />
    );
  }
  if (source === "webhook") {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <SmallField label="Event name" value={trigger.event ?? ""} placeholder="pull_request" onChange={(v) => onPatch({ event: v })} />
        <SmallField label="Secret ref" value={trigger.secretRef ?? ""} placeholder="github-webhook" mono onChange={(v) => onPatch({ secretRef: v })} />
      </div>
    );
  }
  if (source === "plugin") return <PluginTriggerPicker trigger={trigger} onPatch={onPatch} />;
  if (source === "session") {
    return <p className="text-[11px] text-muted-fg/70">Runs after any agent session ends.</p>;
  }
  return <p className="text-[11px] text-muted-fg/70">Runs only when you press Run now.</p>;
}


/**
 * The pair as one select value. `::` is an unambiguous separator: a plugin id
 * is `[a-z][a-z0-9-]*` and a trigger id is a JS identifier, so neither can
 * contain a colon.
 */
function optionKey(pluginId: string, value: string): string {
  return `${pluginId}::${value}`;
}

/**
 * Which plugin event fires this rule.
 *
 * Every enabled plugin's declared triggers in one list, each attributed with
 * the plugin's display name — the same trigger label ("Issue moved") can come
 * from two plugins, and the name is the only thing that tells them apart.
 *
 * A rule pointing at a plugin that is no longer installed keeps a synthetic
 * option of its own rather than snapping to the first available one: an
 * uninstalled plugin is a temporary condition (reinstall it and the rule works
 * again), and silently rewriting a saved rule to point somewhere else would
 * lose what the user authored.
 */
function PluginTriggerPicker({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  const options = usePluginAutomationTriggers();
  const selectedPlugin = (trigger.pluginId ?? "").trim();
  const selectedTrigger = (trigger.pluginTrigger ?? "").trim();
  const known = options.some(
    (option) => option.pluginId === selectedPlugin && option.value === selectedTrigger,
  );
  const orphan: PluginAutomationOption | null = !known && selectedPlugin && selectedTrigger
    ? {
        pluginId: selectedPlugin,
        pluginName: selectedPlugin,
        value: selectedTrigger,
        label: `${selectedTrigger} — not installed`,
      }
    : null;
  const rendered = orphan ? [orphan, ...options] : options;

  if (!rendered.length) {
    return (
      <p className="text-[11px] leading-relaxed text-muted-fg/70">
        No installed plugin declares an automation trigger yet. Install one from the Marketplace,
        then pick its event here.
      </p>
    );
  }

  return (
    <label className="block space-y-1">
      <span className={labelCls}>Plugin event</span>
      <select
        className={selectCls}
        value={known || orphan ? optionKey(selectedPlugin, selectedTrigger) : ""}
        onChange={(e) => {
          const [pluginId = "", pluginTrigger = ""] = e.target.value.split("::");
          onPatch({ pluginId, pluginTrigger });
        }}
      >
        <option value="" disabled>
          Select a plugin event
        </option>
        {rendered.map((option) => (
          <option key={optionKey(option.pluginId, option.value)} value={optionKey(option.pluginId, option.value)}>
            {option.pluginName} — {option.label}
          </option>
        ))}
      </select>
      {orphan ? (
        <span className="block text-[10.5px] text-amber-200/80">
          The {orphan.pluginId} plugin isn't installed on this machine, so this rule can't fire.
        </span>
      ) : null}
    </label>
  );
}

export function TriggerCard({
  trigger,
  ingressStatus,
  onChange,
  onIngressChanged,
}: {
  trigger: AutomationTrigger;
  ingressStatus: AutomationIngressStatus | null;
  onChange: (next: AutomationTrigger) => void;
  onIngressChanged?: () => void;
}) {
  const source = sourceForTriggerType(trigger.type);
  const cursorCloudSurfaceVisible = useBuiltinSurfaceVisible("cursor-cloud");
  const def = sourceDef(source);
  const events = def.events;
  const deliveryKey = triggerDeliveryKeyForType(trigger.type);
  const delivery = deliveryKey ? ingressStatus?.delivery?.[deliveryKey] : null;

  /**
   * The sources this machine may start a NEW automation from.
   *
   * Cursor Cloud's two triggers are ADE's own, and `ade-cursor-cloud` publishes
   * its own pair. Offering both would put two "A Cursor Cloud agent finishes"
   * rows in front of the user, wired to different halves of the same feature.
   * The source that is already SELECTED always stays offered, so opening a
   * saved cursor automation after installing the plugin shows the automation
   * that exists rather than silently re-pointing its trigger at GitHub.
   */
  const offeredTriggerSources = TRIGGER_SOURCES.filter(
    (candidate) => candidate.value === source
      || candidate.value !== "cursor"
      || cursorCloudSurfaceVisible,
  );
  const setSource = (nextSource: TriggerSource) => onChange(defaultTriggerForSource(nextSource));
  const setEvent = (type: string) => onChange({ ...defaultTriggerForSource(source), type: type as AutomationTrigger["type"] });
  const patch = (p: Partial<AutomationTrigger>) => onChange({ ...trigger, ...p });

  return (
    <div className="space-y-3">
      {/* Source picker */}
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
        {offeredTriggerSources.map((s) => {
          const Icon = s.icon;
          const active = s.value === source;
          const iconWeight = s.value === "github" || active ? "fill" : "regular";
          return (
            <button
              key={s.value}
              type="button"
              onClick={() => setSource(s.value)}
              title={s.hint}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[10.5px] font-medium transition-colors",
                active
                  ? "text-fg"
                  : "border-white/[0.06] bg-white/[0.02] text-muted-fg/75 hover:border-white/[0.14] hover:text-fg",
              )}
              style={active ? { borderColor: accentTint(s.value, 0.45), background: accentTint(s.value, 0.1) } : undefined}
            >
              <span style={{ color: s.accent, opacity: active ? 1 : 0.8 }}>
                <Icon size={15} weight={iconWeight} />
              </span>
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Event selector */}
      {events.length > 1 ? (
        <label className="block space-y-1">
          <span className={labelCls}>Event</span>
          <select className={selectCls} value={trigger.type} onChange={(e) => setEvent(e.target.value)}>
            {events.map((event) => (
              <option key={event.value} value={event.value}>
                {event.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="text-[11px] text-muted-fg/70">
          {eventLabel(trigger.type)}
        </div>
      )}

      {deliveryKey && delivery && !delivery.ready ? (
        <TriggerDeliveryCallout deliveryKey={deliveryKey} status={delivery} onIngressChanged={onIngressChanged} />
      ) : null}

      {/* Filters */}
      <div className={cn(recessedCls, "p-3")}>
        <TriggerFilters trigger={trigger} source={source} onPatch={patch} />
      </div>
    </div>
  );
}
