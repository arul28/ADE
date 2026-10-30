import { useEffect, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { showToast } from "../app/toast/toastStore";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { settingsMachinePageFor } from "./SettingsMachinesNav";
import { useSettingsMachines } from "./machines/settingsMachinesContext";
import { MachinePicker, reachableMachines } from "./ProvidersMachinePicker";

/** The anchor every link to this setting uses, including ones made before it moved here. */
export const CONTINUE_AFTER_RESTART_ANCHOR = "continue-after-restart";

/**
 * "Continue chats after restarts": one value per machine, because each
 * machine's brain decides its own resumes after an update, a crash or a
 * reboot. Read from and written to the machine this page is scoped to.
 * Renders nothing where the call does not exist (the hosted web client).
 */
export function ContinueAfterRestartSection() {
  const scope = useSettingsMachineScope();
  const { machines, thisMachineName } = useSettingsMachines();
  // One value per machine: the section can act on any machine whose brain is
  // reachable from here, through that machine's pin. This computer by default.
  const [pickedId, setPickedId] = useState<string>(scope.machineId);
  const picked = machines.find((machine) => machine.machineId === pickedId) ?? null;
  const pickedScope = picked && !picked.isThisMachine ? settingsMachinePageFor(picked) : null;
  const pin = pickedScope ? pickedScope.pin : scope.pin;
  const isThisMachine = pickedScope ? false : scope.isThisMachine;
  const machineName = pickedScope ? pickedScope.machineName : scope.machineName;
  const pinKey = pin?.key ?? null;
  const available = isAdeAvailable(window.ade.ai?.getContinueAfterRestart);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    setEnabled(null);
    setFailed(false);
    window.ade.ai.getContinueAfterRestart(pin)
      .then((answer) => {
        if (!cancelled) setEnabled(answer.enabled !== false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the machine, not the pin object: a rebuilt pin is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, pinKey]);

  if (!available) return null;

  const save = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setEnabled(next);
    try {
      const answer = await window.ade.ai.setContinueAfterRestart(next, pin);
      setEnabled(answer.enabled);
    } catch (error) {
      setEnabled(!next);
      showToast({
        title: "Couldn't save the setting",
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModernSection
      group="Restarts"
      anchor="chat-restarts"
      title="Restarts"
      hint={reachableMachines(machines).length > 1 ? (
        <span className="ade-restarts-on">
          On
          <MachinePicker
            machines={machines}
            selectedId={pickedId}
            thisMachineName={thisMachineName}
            onPick={setPickedId}
          />
        </span>
      ) : isThisMachine ? "On this computer." : `On ${machineName}.`}
      icon={<ArrowClockwise size={16} weight="bold" />}
      tone="green"
    >
      <ModernRows>
        <ModernRow
          anchor={CONTINUE_AFTER_RESTART_ANCHOR}
          title="Continue chats after restarts"
          hint={failed
            ? "Unavailable right now."
            : "After an update, a crash or a reboot, a chat picks up where it stopped. One waiting for your answer waits."}
          control={(
            <SettingsToggle
              label="Continue chats after restarts"
              checked={enabled ?? true}
              disabled={enabled == null || saving}
              onChange={(next) => void save(next)}
            />
          )}
        />
      </ModernRows>
    </ModernSection>
  );
}
