import React from "react";
import type { WebClientEnvironmentRecord } from "../sync";
import { ScreenShell } from "./ScreenShell";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, recessedStyle } from "./shellTokens";

function lastConnectedLabel(value: string | null | undefined): string {
  if (!value) return "Never connected";
  try {
    return `Last connected ${new Date(value).toLocaleString()}`;
  } catch {
    return "Previously connected";
  }
}

/** Full-screen chooser when several machines are paired and none is selected. */
export function MachinePicker({
  environments,
  onSelect,
  onPair,
}: {
  environments: WebClientEnvironmentRecord[];
  onSelect: (environment: WebClientEnvironmentRecord) => void;
  onPair: () => void;
}) {
  return (
    <ScreenShell title="Choose a machine" subtitle="Pick which paired machine to connect to.">
      <div style={{ display: "grid", gap: 10 }}>
        {environments.map((environment) => (
          <button
            key={environment.envId}
            type="button"
            onClick={() => onSelect(environment)}
            style={recessedStyle({
              display: "grid",
              gap: 4,
              textAlign: "left",
              cursor: "pointer",
              border: `1px solid ${COLORS.border}`,
            })}
          >
            <span style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
              {environment.machineName}
            </span>
            <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11 }}>
              {lastConnectedLabel(environment.lastConnectedAt)}
            </span>
          </button>
        ))}
      </div>
      <button type="button" style={outlineButton({ justifySelf: "start" })} onClick={onPair}>
        Pair a new machine
      </button>
    </ScreenShell>
  );
}
