import { useCallback, useEffect, useState } from "react";
import { Lock, Robot } from "@phosphor-icons/react";
import {
  AGENT37_CAP_CHOICES_USD,
  AGENT37_LIMITS_PRESETS,
  AGENT37_MACHINES_PER_DAY_CHOICES,
  AGENT37_SHAPES,
  agent37LimitsPresetOf,
  type Agent37AgentLimits,
  type Agent37Budget,
} from "../../../shared/agent37";
import { IntegrationCard, IntegrationChoice } from "./integrations/IntegrationChrome";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";

function shapeLabel(id: string): string {
  const shape = AGENT37_SHAPES.find((entry) => entry.id === id);
  return shape ? `${shape.cpu} vCPU · ${shape.memoryGb} GB` : id;
}

/**
 * Settings › Integrations › Agent 37 › What agents may spend: what an agent
 * may do when nobody is watching (a full-auto chat, an automation), as one
 * yes/no with its limits under Yes (the preset is derived), and the optional
 * monthly cap. Account-wide (the
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

  const unattended = limits?.unattendedSpend ?? null;
  // "Yes" starts from Balanced's limits when the saved ones are the "No" preset's leftovers.
  const allow = (value: boolean) => {
    if (!limits || limits.unattendedSpend === value) return;
    void save({ agents: value && preset === "ask" ? AGENT37_LIMITS_PRESETS.balanced : { ...limits, unattendedSpend: value } });
  };

  return (
    <IntegrationCard
      anchor="agent37-agent-limits"
      span="full"
      icon={<Robot size={15} weight="fill" />}
      title="What agents may spend"
      hint="A watched agent always asks in its chat with an Allow / Don't allow card."
    >
      <div className="ade-ig-limit-rows">
        <div className="ade-ig-limit-row">
          <div><b>When nobody is watching, may agents make or change machines?</b><small>Nobody is watching a full-auto chat or an automation run.</small></div>
          <IntegrationChoice
            label="When nobody is watching, may agents make or change machines?"
            value={unattended == null ? null : unattended ? "yes" : "no"}
            disabled={disabled}
            onChange={(choice) => allow(choice === "yes")}
            options={[
              { value: "no", label: "No, they ask you first" },
              { value: "yes", label: "Yes, within these limits" },
            ]}
          />
        </div>
        {unattended ? (
          <>
            <div className="ade-ig-limit-row">
              <div><b>New machines a day</b><small>Made, copied or moved by agents</small></div>
              <IntegrationChoice
                label="New machines a day"
                value={limits?.machinesPerDay ?? null}
                disabled={disabled}
                sentenceCase={false}
                onChange={(count) => setLimit({ machinesPerDay: count })}
                options={AGENT37_MACHINES_PER_DAY_CHOICES.map((count) => ({ value: count, label: String(count) }))}
              />
            </div>
            <div className="ade-ig-limit-row">
              <div><b>Largest size</b><small>Bigger machines cost more an hour</small></div>
              <IntegrationChoice
                label="Largest size"
                value={limits?.maxShape ?? null}
                disabled={disabled}
                sentenceCase={false}
                onChange={(maxShape) => setLimit({ maxShape })}
                options={AGENT37_SHAPES.map((shape) => ({ value: shape.id, label: `${shape.cpu}·${shape.memoryGb}`, title: shapeLabel(shape.id) }))}
              />
            </div>
          </>
        ) : null}
        <div className="ade-ig-limit-row">
          <div><b>Monthly cap</b><small>Optional, for every machine. Your Agent 37 wallet is prepaid, so it already caps what you can spend.</small></div>
          <IntegrationChoice
            label="Monthly cap"
            value={cap ?? "off"}
            disabled={disabled}
            onChange={(choice) => void save({ monthlyCapUsd: choice === "off" ? null : choice })}
            options={[{ value: "off" as const, label: "Off" }, ...AGENT37_CAP_CHOICES_USD.map((usd) => ({ value: usd, label: `$${usd}` }))]}
          />
        </div>
      </div>

      <p className="ade-ig-note"><Lock size={13} weight="fill" /> Always yours to decide: keeping a machine awake for good, raising the cap or these limits, and deleting a machine an agent didn't make.</p>
      {error ? (
        <Banner layout="inline" model={{ id: "agent37-limits-error", tone: "error", title: "What agents may spend", detail: error, actions: [{ label: "Dismiss", onClick: () => setError(null) }] }} />
      ) : null}
    </IntegrationCard>
  );
}
