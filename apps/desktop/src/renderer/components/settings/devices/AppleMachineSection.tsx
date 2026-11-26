import React from "react";
import { AppleLogo, Cloud, DeviceMobileCamera } from "@phosphor-icons/react";
import { isMacRuntimeTarget } from "../../../lib/platform";
import { isWebClientMode } from "../../../lib/webClientMode";
import { adeCloudEnabled } from "../../../state/cloudAccess";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { useMachineFacts, type MachineFacts } from "../machines/machineFacts";
import { useSettingsMachines } from "../machines/settingsMachinesContext";
import { ModernSection } from "../primitives";
import { AppleToolsSection } from "./AppleToolsSection";
import { ListSkeleton } from "./devToolsList";
import { useDevToolsStorage } from "./useDevToolsStorage";

/**
 * The machine half of Settings › Apple devices, for the machine picked in the
 * page title (`?machine=`). A Mac shows its Xcode, simulators, runtimes and
 * build data. Any other machine says the simulator needs a Mac and offers the
 * ADE Cloud iPhone and the person's own Macs instead, so a Windows laptop
 * never meets an empty page or an error.
 */

type MachineKind = "mac" | "other" | "unknown";

/**
 * Whether the page's machine is a Mac. This computer answers for itself; the
 * hosted web client's browser is not the machine, so there and for a machine
 * whose facts have not arrived the answer is "unknown" and the brain decides
 * (its build-data read says `supported: false` off a Mac).
 */
function machineKind(isThisMachine: boolean, fact: MachineFacts | undefined): MachineKind {
  if (isWebClientMode()) return "unknown";
  if (isThisMachine) return isMacRuntimeTarget() ? "mac" : "other";
  if (!fact || fact.platform === "unknown") return "unknown";
  return fact.platform === "mac" ? "mac" : "other";
}

const SECTION_TITLE = "Xcode and simulators";

export function AppleMachineSection() {
  const scope = useSettingsMachineScope();
  const { machines, machineNames, openMachine, openTab } = useSettingsMachines();
  const facts = useMachineFacts(machines, null);
  const kind = machineKind(scope.isThisMachine, facts.get(scope.machineId));
  const machine = machines.find((entry) => entry.machineId === scope.machineId) ?? null;
  // The person's other Macs this page can reach: online, with a copy of this project.
  const macs = machines
    .filter((entry) => entry.machineId !== scope.machineId && entry.online && entry.hasRepo && facts.get(entry.machineId)?.platform === "mac")
    .map((entry) => ({ id: entry.machineId, name: machineNames.get(entry.machineId) ?? entry.machineName }));
  const needsMac = (
    <NeedsMacCard
      machineName={scope.isThisMachine ? "This computer" : scope.machineName}
      macs={macs}
      onPickMac={(id) => openMachine(id, "apple")}
      onOpenCloud={adeCloudEnabled() ? () => openTab("ade-cloud") : null}
    />
  );

  if (kind === "other") return needsMac;
  if (!scope.target) {
    const why = machine && !machine.online
      ? `${scope.machineName} is offline. Its simulators show here when it is back.`
      : `${scope.machineName} has no copy of this project, so its simulators can't be read from here.`;
    return (
      <ModernSection group="Apple Development" anchor="apple-xcode" title={SECTION_TITLE}>
        <div className="ade-dev-empty">{why}</div>
      </ModernSection>
    );
  }
  return (
    <AppleMachineTools
      // Another machine is another set of rows: nothing from the last one stays on screen.
      key={scope.pin?.key ?? "this"}
      machineName={scope.isThisMachine ? "this Mac" : scope.machineName}
      confirmMac={kind === "unknown"}
      needsMac={needsMac}
    />
  );
}

function AppleMachineTools({ machineName, confirmMac, needsMac }: { machineName: string; confirmMac: boolean; needsMac: React.ReactNode }) {
  const scope = useSettingsMachineScope();
  const storage = useDevToolsStorage({ pin: scope.pin, apple: true, android: false });
  if (confirmMac) {
    // Not known to be a Mac: wait for the brain's answer instead of flashing errors from a Windows box.
    const answer = storage.buildData.data;
    if (answer?.supported === false) return <>{needsMac}</>;
    if (!answer && !storage.buildData.error) {
      return (
        <ModernSection group="Apple Development" anchor="apple-xcode" title={SECTION_TITLE}>
          <ListSkeleton rows={2} />
        </ModernSection>
      );
    }
  }
  return <AppleToolsSection storage={storage} pin={scope.pin} machineName={machineName} />;
}

function NeedsMacCard({
  machineName,
  macs,
  onPickMac,
  onOpenCloud,
}: {
  machineName: string;
  macs: Array<{ id: string; name: string }>;
  onPickMac: (id: string) => void;
  onOpenCloud: (() => void) | null;
}) {
  const offer = onOpenCloud
    ? `Use the ADE Cloud iPhone from any computer${macs.length ? ", or one of your Macs" : ""}.`
    : macs.length ? "Use one of your Macs." : "Open ADE on a Mac to use one.";
  return (
    <ModernSection group="Apple Development" anchor="apple-xcode" title={SECTION_TITLE}>
      <div className="ade-dev-card ade-dev-needsmac">
        <span className="ade-dev-needsmac-art" aria-hidden>
          <DeviceMobileCamera size={30} weight="duotone" />
        </span>
        <div className="ade-dev-needsmac-text">
          <div className="ade-dev-needsmac-title">The iOS Simulator runs on a Mac</div>
          <p className="ade-dev-needsmac-body">{machineName} can't run Xcode. {offer} A lane's Apple pane picks it for you.</p>
          {onOpenCloud || macs.length ? (
            <div className="ade-dev-needsmac-actions">
              {onOpenCloud ? (
                <button type="button" className="ade-modern-btn" data-size="sm" onClick={onOpenCloud}>
                  <Cloud size={13} />
                  ADE Cloud iPhone
                </button>
              ) : null}
              {macs.map((mac) => (
                <button key={mac.id} type="button" className="ade-modern-btn" data-size="sm" data-variant="ghost" onClick={() => onPickMac(mac.id)} title={`Show ${mac.name}'s simulators`}>
                  <AppleLogo size={13} weight="fill" />
                  {mac.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </ModernSection>
  );
}
