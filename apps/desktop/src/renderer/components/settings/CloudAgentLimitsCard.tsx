import { useCallback, useEffect, useState } from "react";
import { Lock, Robot } from "@phosphor-icons/react";
import {
  CLOUD_LIMITS_PRESETS,
  CLOUD_MACHINES_PER_DAY_CHOICES,
  CLOUD_SHAPES,
  cloudLimitsPresetOf,
  type CloudAgentLimits,
} from "../../../shared/adeCloud";
import { IntegrationCard, IntegrationChoice } from "./integrations/IntegrationChrome";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";

/**
 * Settings › Integrations › ADE Cloud › What agents may do: what an agent may
 * do when nobody is watching (a full-auto chat, an automation), as one yes/no
 * with its limits under Yes (the preset is derived). Account-wide (the account
 * vault), so it asks this desktop's main process with no pin.
 */
export function CloudAgentLimitsCard() {
  const bridge = window.ade.cloud;
  const [limits, setLimits] = useState<CloudAgentLimits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bridge?.getAgentLimits) return;
    try {
      setLimits(await bridge.getAgentLimits());
    } catch (loadError) {
      setError(ipcErrorMessage(loadError) || "Couldn't read what agents may do.");
    }
  }, [bridge]);

  useEffect(() => {
    void load();
    const off = bridge?.onStatusChanged?.(() => { void load(); });
    return () => off?.();
  }, [bridge, load]);

  if (!bridge?.getAgentLimits || !bridge.setAgentLimits) return null;
  const write = bridge.setAgentLimits;

  const save = async (next: Partial<CloudAgentLimits>) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await write(next);
      if (saved) setLimits(saved);
    } catch (saveError) {
      setError(ipcErrorMessage(saveError) || "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  };

  const preset = limits ? cloudLimitsPresetOf(limits) : null;
  const setLimit = (patch: Partial<CloudAgentLimits>) => {
    if (limits) void save({ ...limits, ...patch });
  };
  const disabled = busy || limits == null;

  const unattended = limits?.unattendedSpend ?? null;
  // "Yes" starts from Balanced's limits when the saved ones are the "No" preset's leftovers.
  const allow = (value: boolean) => {
    if (!limits || limits.unattendedSpend === value) return;
    void save(value && preset === "ask" ? CLOUD_LIMITS_PRESETS.balanced : { ...limits, unattendedSpend: value });
  };

  return (
    <IntegrationCard
      anchor="cloud-agent-limits"
      span="full"
      icon={<Robot size={15} weight="fill" />}
      title="What agents may do"
      hint="A watched agent always asks in its chat with an Allow / Don't allow card."
    >
      <div className="ade-ig-limit-rows">
        <div className="ade-ig-limit-row">
          <div><b>When nobody is watching, may agents make or change computers?</b><small>Nobody is watching a full-auto chat or an automation run.</small></div>
          <IntegrationChoice
            label="When nobody is watching, may agents make or change computers?"
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
              <div><b>New computers a day</b><small>Made, copied or moved by agents</small></div>
              <IntegrationChoice
                label="New computers a day"
                value={limits?.machinesPerDay ?? null}
                disabled={disabled}
                sentenceCase={false}
                onChange={(count) => setLimit({ machinesPerDay: count })}
                options={CLOUD_MACHINES_PER_DAY_CHOICES.map((count) => ({ value: count, label: String(count) }))}
              />
            </div>
            <div className="ade-ig-limit-row">
              <div><b>Largest size</b><small>Bigger computers use hours faster</small></div>
              <IntegrationChoice
                label="Largest size"
                value={limits?.maxShape ?? null}
                disabled={disabled}
                sentenceCase={false}
                onChange={(maxShape) => setLimit({ maxShape })}
                options={CLOUD_SHAPES.map((shape) => ({ value: shape.id, label: shape.label, title: `${shape.cpu} CPU · ${shape.memoryGb} GB` }))}
              />
            </div>
          </>
        ) : null}
      </div>

      <p className="ade-ig-note"><Lock size={13} weight="fill" /> Always yours to decide: keeping a computer awake for good, raising these limits, and deleting a computer an agent didn't make.</p>
      {error ? (
        <Banner layout="inline" model={{ id: "cloud-limits-error", tone: "error", title: "What agents may do", detail: error, actions: [{ label: "Dismiss", onClick: () => setError(null) }] }} />
      ) : null}
    </IntegrationCard>
  );
}
