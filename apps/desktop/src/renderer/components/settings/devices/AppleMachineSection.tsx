import React from "react";
import { AppleLogo, Cloud, DeviceMobileCamera } from "@phosphor-icons/react";
import { isMacRuntimeTarget } from "../../../lib/platform";
import { adeCloudEnabled } from "../../../state/cloudAccess";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { useMachineFacts } from "../machines/machineFacts";
import { useSettingsMachines } from "../machines/settingsMachinesContext";
import { ModernSection } from "../primitives";
import { AppleToolsSection } from "./AppleToolsSection";
import { useDevToolsStorage } from "./useDevToolsStorage";
import "./devTools.css";

/**
 * The machine half of Settings › Apple devices, for the machine picked in the
 * page title (`?machine=`). A Mac shows its Xcode, simulators, runtimes and
 * build data. Any other machine says the simulator needs a Mac and offers the
 * ADE Cloud iPhone and the person's own Macs instead, so a Windows laptop
 * never meets an empty page or an error.
 */
export function AppleMachineSection() {
  const scope = useSettingsMachineScope();
  const { machines, machineNames, openMachine, openTab } = useSettingsMachines();
  const facts = useMachineFacts(machines, null);
  const platform = scope.isThisMachine
    ? (isMacRuntimeTarget() ? "mac" : "other")
    : facts.get(scope.machineId)?.platform === "mac"
      ? "mac"
      : facts.get(scope.machineId)?.platform === "unknown" || facts.get(scope.machineId) == null
        ? "unknown"
        : "other";
  const machineName = scope.isThisMachine ? "this Mac" : scope.machineName;

  if (platform === "other") {
    const macs = machines.filter((machine) => !machine.isThisMachine && machine.machineId !== scope.machineId && facts.get(machine.machineId)?.platform === "mac");
    return (
      <NeedsMacCard
        machineName={scope.isThisMachine ? "This computer" : scope.machineName}
        macs={macs.map((machine) => ({ id: machine.machineId, name: machineNames.get(machine.machineId) ?? machine.machineName, online: machine.online }))}
        onPickMac={(id) => openMachine(id, "apple")}
        onOpenCloud={adeCloudEnabled() ? () => openTab("ade-cloud") : null}
      />
    );
  }
  if (!scope.target) {
    return (
      <ModernSection group="Apple Development" anchor="apple-xcode" title="Xcode and simulators">
        <div className="ade-dev-empty">ADE can't reach {scope.machineName} right now. Its simulators show here when it is online.</div>
      </ModernSection>
    );
  }
  return <AppleMachineTools machineName={machineName} />;
}

function AppleMachineTools({ machineName }: { machineName: string }) {
  const scope = useSettingsMachineScope();
  const storage = useDevToolsStorage({ pin: scope.pin, apple: true, android: false });
  return <AppleToolsSection storage={storage} pin={scope.pin} machineName={machineName} />;
}

function NeedsMacCard({
  machineName,
  macs,
  onPickMac,
  onOpenCloud,
}: {
  machineName: string;
  macs: Array<{ id: string; name: string; online: boolean }>;
  onPickMac: (id: string) => void;
  onOpenCloud: (() => void) | null;
}) {
  return (
    <ModernSection group="Apple Development" anchor="apple-xcode" title="Xcode and simulators">
      <div className="ade-dev-card ade-dev-needsmac">
        <span className="ade-dev-needsmac-art" aria-hidden>
          <DeviceMobileCamera size={30} weight="duotone" />
        </span>
        <div className="ade-dev-needsmac-text">
          <div className="ade-dev-needsmac-title">The iOS Simulator runs on a Mac</div>
          <p className="ade-dev-needsmac-body">
            {machineName} can't run Xcode.{" "}
            {onOpenCloud ? "Use the ADE Cloud iPhone from any computer" : "Use one of your Macs"}
            {onOpenCloud && macs.length ? ", or one of your Macs" : ""}. A lane's Apple pane picks it for you.
          </p>
          <div className="ade-dev-needsmac-actions">
            {onOpenCloud ? (
              <button type="button" className="ade-modern-btn" data-size="sm" onClick={onOpenCloud}>
                <Cloud size={13} />
                ADE Cloud iPhone
              </button>
            ) : null}
            {macs.map((mac) => (
              <button
                key={mac.id}
                type="button"
                className="ade-modern-btn"
                data-size="sm"
                data-variant="ghost"
                onClick={() => onPickMac(mac.id)}
                title={mac.online ? `Show ${mac.name}'s simulators` : `${mac.name} is offline`}
              >
                <AppleLogo size={13} weight="fill" />
                {mac.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </ModernSection>
  );
}
