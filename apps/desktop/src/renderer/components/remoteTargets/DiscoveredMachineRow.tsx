import { PlugsConnected } from "@phosphor-icons/react";
import type { RemoteRuntimeDiscoveredMachine } from "../../../shared/types";
import { primaryButton, outlineButton } from "../lanes/laneDesignTokens";
import { ConnectionDoctorPanel } from "./ConnectionDoctorPanel";
import {
  discoveredMachineSummary,
  discoveredRoute,
  type MachineSection,
} from "./remoteMachineModel";
import {
  helperTextStyle,
  machineRowStyle,
  nameStyle,
  subTextStyle,
} from "./remoteTargetListStyles";

type DiscoveredMachineRowProps = {
  machine: RemoteRuntimeDiscoveredMachine;
  section: MachineSection;
  busyId: string | null;
  saving: boolean;
  testOpen: boolean;
  onConnect: (machine: RemoteRuntimeDiscoveredMachine) => void;
  onToggleTest: (machineId: string) => void;
};

export function DiscoveredMachineRow({
  machine,
  section,
  busyId,
  saving,
  testOpen,
  onConnect,
  onToggleTest,
}: DiscoveredMachineRowProps) {
  const route = discoveredRoute(machine);
  const unavailable = section === "unavailable";

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ ...machineRowStyle, opacity: unavailable ? 0.62 : 1 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) auto",
            gap: 12,
            alignItems: "center",
          }}
        >
          <div style={{ minWidth: 0, display: "grid", gap: 5 }}>
            <div style={nameStyle}>{machine.machineName}</div>
            <div style={subTextStyle}>
              {route ? `${route}:${machine.port}` : "No route advertised"}
            </div>
            <div style={helperTextStyle}>
              {unavailable && machine.unsupportedReason
                ? machine.unsupportedReason
                : discoveredMachineSummary(machine)}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            {!unavailable ? (
              <>
                <button
                  type="button"
                  disabled={!route || busyId != null || saving}
                  onClick={() => onConnect(machine)}
                  style={{
                    ...primaryButton({
                      height: 30,
                      padding: "0 10px",
                      fontSize: 11,
                    }),
                    opacity: route && busyId == null && !saving ? 1 : 0.55,
                  }}
                >
                  <PlugsConnected size={14} weight="bold" />
                  {busyId === machine.id ? "Connecting…" : "Connect"}
                </button>
                <button
                  type="button"
                  aria-controls={`remote-discovered-test-${machine.id}`}
                  aria-expanded={testOpen}
                  disabled={busyId != null}
                  onClick={() => onToggleTest(machine.id)}
                  style={outlineButton({
                    height: 30,
                    padding: "0 10px",
                    fontSize: 11,
                  })}
                >
                  Test
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
      {testOpen ? (
        <div id={`remote-discovered-test-${machine.id}`}>
          <ConnectionDoctorPanel machineId={machine.id} />
        </div>
      ) : null}
    </div>
  );
}
