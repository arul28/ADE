import { PlugsConnected, WifiHigh } from "@phosphor-icons/react";
import type { RemoteRuntimeDiscoveredMachine } from "../../../shared/types";
import { outlineButton } from "../lanes/laneDesignTokens";
import { ConnectionDoctorPanel } from "./ConnectionDoctorPanel";
import {
  discoveredRoute,
  type MachineSection,
} from "./remoteMachineModel";
import {
  connectButtonStyle,
  helperTextStyle,
  machineRowStyle,
  nameStyle,
  subTextStyle,
} from "./remoteTargetListStyles";

type DiscoveredMachineRowProps = {
  machine: RemoteRuntimeDiscoveredMachine;
  section: MachineSection;
  /** This machine's own connect is in flight. Other rows never set it. */
  busy: boolean;
  testOpen: boolean;
  onConnect: (machine: RemoteRuntimeDiscoveredMachine) => void;
  onToggleTest: (machineId: string) => void;
};

export function DiscoveredMachineRow({
  machine,
  section,
  busy,
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
            gridTemplateColumns: "auto minmax(0,1fr) auto",
            gap: 12,
            alignItems: "center",
          }}
        >
          <span className="ade-cx-found-icon" aria-hidden>
            <WifiHigh size={17} weight="bold" />
          </span>
          <div style={{ minWidth: 0, display: "grid", gap: 3 }}>
            <div style={nameStyle}>{machine.machineName}</div>
            <div style={unavailable ? helperTextStyle : subTextStyle}>
              {unavailable && machine.unsupportedReason
                ? machine.unsupportedReason
                : "Found on your network · ready to pair"}
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
                  disabled={!route || busy}
                  onClick={() => onConnect(machine)}
                  style={{
                    ...connectButtonStyle,
                    opacity: route && !busy ? 1 : 0.55,
                  }}
                >
                  <PlugsConnected size={14} weight="bold" />
                  {busy ? "Opening…" : "Pair"}
                </button>
                <button
                  type="button"
                  aria-controls={`remote-discovered-test-${machine.id}`}
                  aria-expanded={testOpen}
                  disabled={busy}
                  onClick={() => onToggleTest(machine.id)}
                  style={outlineButton({
                    height: 28,
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
        <div id={`remote-discovered-test-${machine.id}`} className="ade-cx-inset">
          <ConnectionDoctorPanel machineId={machine.id} machineName={machine.machineName} />
        </div>
      ) : null}
    </div>
  );
}
