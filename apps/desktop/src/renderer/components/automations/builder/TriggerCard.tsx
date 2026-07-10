import { CheckCircle, Warning } from "@phosphor-icons/react";
import type { AutomationIngressStatus, AutomationTrigger } from "../../../../shared/types";
import { isWebhookGatewayTriggerType } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { inputCls, labelCls, recessedCls, selectCls } from "../designTokens";
import {
  defaultTriggerForSource,
  eventLabel,
  sourceDef,
  sourceForTriggerType,
  TRIGGER_SOURCES,
  type TriggerSource,
} from "../triggerCatalog";
import { GitHubTriggerFilters } from "../GitHubTriggerFilters";
import { LinearTriggerFilters } from "../LinearTriggerFilters";
import { ScheduleEditor } from "./ScheduleEditor";

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

function WebhookGatewayCallout({ status }: { status: AutomationIngressStatus["webhookGateway"] | null }) {
  const ready = status?.ready === true;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-[11px]",
        ready
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
          : "border-amber-500/25 bg-amber-500/10 text-amber-200",
      )}
    >
      {ready ? <CheckCircle size={13} weight="fill" className="mt-px shrink-0" /> : <Warning size={13} weight="regular" className="mt-px shrink-0" />}
      <span className="leading-relaxed">
        {ready
          ? status?.publicUrl
            ? `Events arrive through ${status.publicUrl}.`
            : "Events can reach this ADE runtime."
          : "This trigger needs the webhook gateway online to receive events."}
      </span>
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
  if (source === "session") {
    return <p className="text-[11px] text-muted-fg/70">Runs after any agent session ends.</p>;
  }
  return <p className="text-[11px] text-muted-fg/70">Runs only when you press Run now.</p>;
}

export function TriggerCard({
  trigger,
  ingressStatus,
  onChange,
}: {
  trigger: AutomationTrigger;
  ingressStatus: AutomationIngressStatus | null;
  onChange: (next: AutomationTrigger) => void;
}) {
  const source = sourceForTriggerType(trigger.type);
  const def = sourceDef(source);
  const events = def.events;
  const needsGateway = isWebhookGatewayTriggerType(trigger.type);

  const setSource = (nextSource: TriggerSource) => onChange(defaultTriggerForSource(nextSource));
  const setEvent = (type: string) => onChange({ ...defaultTriggerForSource(source), type: type as AutomationTrigger["type"] });
  const patch = (p: Partial<AutomationTrigger>) => onChange({ ...trigger, ...p });

  return (
    <div className="space-y-3">
      {/* Source picker */}
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
        {TRIGGER_SOURCES.map((s) => {
          const Icon = s.icon;
          const active = s.value === source;
          return (
            <button
              key={s.value}
              type="button"
              onClick={() => setSource(s.value)}
              title={s.hint}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[10.5px] font-medium transition-colors",
                active
                  ? "border-accent/45 bg-accent/[0.1] text-fg"
                  : "border-white/[0.06] bg-white/[0.02] text-muted-fg/75 hover:border-white/[0.14] hover:text-fg",
              )}
            >
              <Icon size={15} weight={active ? "fill" : "regular"} className={active ? "text-accent" : ""} />
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

      {needsGateway ? <WebhookGatewayCallout status={ingressStatus?.webhookGateway ?? null} /> : null}

      {/* Filters */}
      <div className={cn(recessedCls, "p-3")}>
        <TriggerFilters trigger={trigger} source={source} onPatch={patch} />
      </div>
    </div>
  );
}
