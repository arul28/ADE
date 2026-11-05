import { useCallback, useEffect, useState } from "react";
import { Lock, Robot, RocketLaunch, Scales, ShieldCheck } from "@phosphor-icons/react";
import {
  AGENT37_CAP_CHOICES_USD,
  AGENT37_LIMITS_PRESETS,
  AGENT37_MACHINES_PER_DAY_CHOICES,
  AGENT37_SHAPES,
  agent37LimitsPresetOf,
  type Agent37AgentLimits,
  type Agent37Budget,
  type Agent37LimitsPreset,
} from "../../../shared/agent37";
import { IntegrationCard } from "./integrations/IntegrationChrome";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";

const PRESETS: Array<{ id: Agent37LimitsPreset; name: string; line: string; icon: typeof ShieldCheck; recommended?: boolean }> = [
  { id: "ask", name: "Ask me", line: "Nothing costs money without your yes.", icon: ShieldCheck },
  { id: "balanced", name: "Balanced", line: "Agents get what they need, within limits.", icon: Scales, recommended: true },
  { id: "hands_off", name: "Hands-off", line: "For big runs: many machines at once.", icon: RocketLaunch },
];

function shapeLabel(id: string): string {
  const shape = AGENT37_SHAPES.find((entry) => entry.id === id);
  return shape ? `${shape.cpu} vCPU · ${shape.memoryGb} GB` : id;
}

function presetLines(limits: Agent37AgentLimits): string[] {
  return [
    limits.unattendedSpend ? "Unattended agents go ahead" : "Unattended agents can't spend",
    `${limits.machinesPerDay} new machine${limits.machinesPerDay === 1 ? "" : "s"} a day`,
    limits.maxShape === AGENT37_SHAPES[AGENT37_SHAPES.length - 1]!.id ? "Any size" : `Up to ${shapeLabel(limits.maxShape)}`,
  ];
}

/**
 * Settings › Integrations › Agent 37 › What agents may spend: what an agent
 * may do when nobody is watching (a full-auto chat, an automation), as three
 * presets or single limits, and the optional monthly cap. Account-wide (the
 * account vault), so it asks this desktop's main process with no pin.
 */
export function Agent37AgentLimitsCard() {
  const bridge = window.ade.agent37;
  const [budget, setBudget] = useState<Agent37Budget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bridge?.getBudget) return;
    try {
      setBudget(await bridge.getBudget());
    } catch (loadError) {
      setError(ipcErrorMessage(loadError) || "Couldn't read what agents may spend.");
    }
  }, [bridge]);

  useEffect(() => {
    void load();
    const off = bridge?.onStatusChanged?.(() => { void load(); });
    return () => off?.();
  }, [bridge, load]);

  if (!bridge?.getBudget || !bridge.setBudget) return null;
  const write = bridge.setBudget;

  const save = async (next: Partial<Agent37Budget>) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await write(next);
      if (saved) setBudget(saved);
    } catch (saveError) {
      setError(ipcErrorMessage(saveError) || "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  };

  const limits = budget?.agents ?? null;
  const preset = limits ? agent37LimitsPresetOf(limits) : null;
  const setLimit = (patch: Partial<Agent37AgentLimits>) => {
    if (limits) void save({ agents: { ...limits, ...patch } });
  };
  const disabled = busy || budget == null;
  const cap = budget?.monthlyCapUsd ?? null;

  return (
    <IntegrationCard
      anchor="agent37-agent-limits"
      span="full"
      icon={<Robot size={15} weight="fill" />}
      title="What agents may spend"
      badge={<span className="kit-tag">{preset ? PRESETS.find((entry) => entry.id === preset)!.name : "Custom"}</span>}
      hint="When you're watching, agents ask first. These choose what an agent may do when nobody is: a full-auto chat or an automation."
    >
      <div className="ade-ig-presets" role="radiogroup" aria-label="What agents may spend">
        {PRESETS.map((entry) => {
          const Icon = entry.icon;
          const on = preset === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={on}
              className="ade-ig-preset"
              data-on={on || undefined}
              disabled={disabled}
              onClick={() => { if (!on) void save({ agents: AGENT37_LIMITS_PRESETS[entry.id] }); }}
            >
              {entry.recommended ? <span className="ade-ig-preset-tag">Recommended</span> : null}
              <Icon size={20} weight="duotone" />
              <b>{entry.name}</b>
              <span>{entry.line}</span>
              <ul>{presetLines(AGENT37_LIMITS_PRESETS[entry.id]).map((line) => <li key={line}>{line}</li>)}</ul>
            </button>
          );
        })}
      </div>

      <div className="ade-ig-limit-rows">
        <div className="ade-ig-limit-row">
          <div><b>Unattended agents may spend</b><small>Off: they ask, like an agent you're watching</small></div>
          <div className="kit-seg" data-case="sentence" role="radiogroup" aria-label="Unattended agents may spend">
            {[true, false].map((value) => (
              <button key={String(value)} type="button" role="radio" aria-checked={limits?.unattendedSpend === value} disabled={disabled}
                onClick={() => { if (limits?.unattendedSpend !== value) setLimit({ unattendedSpend: value }); }}>
                {value ? "Yes" : "No"}
              </button>
            ))}
          </div>
        </div>
        <div className="ade-ig-limit-row">
          <div><b>New machines a day</b><small>Made, copied or moved by agents</small></div>
          <div className="kit-seg" role="radiogroup" aria-label="New machines a day">
            {AGENT37_MACHINES_PER_DAY_CHOICES.map((count) => (
              <button key={count} type="button" role="radio" aria-checked={limits?.machinesPerDay === count} disabled={disabled || limits?.unattendedSpend === false}
                onClick={() => { if (limits?.machinesPerDay !== count) setLimit({ machinesPerDay: count }); }}>
                {count}
              </button>
            ))}
          </div>
        </div>
        <div className="ade-ig-limit-row">
          <div><b>Largest size</b><small>Bigger machines cost more an hour</small></div>
          <div className="kit-seg" role="radiogroup" aria-label="Largest size">
            {AGENT37_SHAPES.map((shape) => (
              <button key={shape.id} type="button" role="radio" aria-checked={limits?.maxShape === shape.id} disabled={disabled || limits?.unattendedSpend === false}
                title={shapeLabel(shape.id)}
                onClick={() => { if (limits?.maxShape !== shape.id) setLimit({ maxShape: shape.id }); }}>
                {shape.cpu}·{shape.memoryGb}
              </button>
            ))}
          </div>
        </div>
        <div className="ade-ig-limit-row">
          <div><b>Monthly cap</b><small>Optional. Your Agent 37 wallet is prepaid, so it already caps what you can spend.</small></div>
          <div className="kit-seg" role="radiogroup" aria-label="Monthly cap">
            {[null, ...AGENT37_CAP_CHOICES_USD].map((usd) => (
              <button key={usd ?? "off"} type="button" role="radio" aria-checked={cap === usd} disabled={disabled}
                onClick={() => { if (cap !== usd) void save({ monthlyCapUsd: usd }); }}>
                {usd == null ? "Off" : `$${usd}`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="ade-ig-note"><Lock size={13} weight="fill" /> Always yours to decide: keeping a machine awake for good, raising the cap or these limits, and deleting a machine an agent didn't make.</p>
      {error ? (
        <Banner layout="inline" model={{ id: "agent37-limits-error", tone: "error", title: "What agents may spend", detail: error, actions: [{ label: "Dismiss", onClick: () => setError(null) }] }} />
      ) : null}
    </IntegrationCard>
  );
}
