import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";

/**
 * Where an update to another machine is. "checking" is the question before
 * the confirmation; "sending" is the call; "restarting" is the wait for the
 * machine to come back on the new version, which includes the disconnect the
 * restart causes.
 */
export type MachineUpdatePhase = "checking" | "sending" | "restarting";

const STEPS: Array<{ phase: "sending" | "restarting" | "back"; label: (target: string) => string }> = [
  { phase: "sending", label: () => "Sending" },
  { phase: "restarting", label: () => "Restarting" },
  { phase: "back", label: (target) => `Back on ${target}` },
];

export function UpdateSteps({ phase, targetVersion }: { phase: "sending" | "restarting"; targetVersion: string | null }) {
  const activeIndex = phase === "sending" ? 0 : 1;
  return (
    <div
      role="progressbar"
      aria-label="Update progress"
      aria-valuemin={0}
      aria-valuemax={STEPS.length}
      aria-valuenow={activeIndex}
      style={{ display: "grid", gridTemplateColumns: `repeat(${STEPS.length}, 1fr)`, gap: 6, paddingLeft: 52 }}
    >
      {STEPS.map((step, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div key={step.phase} style={{ display: "grid", gap: 5 }}>
            <div
              style={{
                height: 3,
                borderRadius: 2,
                overflow: "hidden",
                background: "color-mix(in srgb, var(--color-fg) 10%, transparent)",
              }}
            >
              <div
                className={active ? "ade-machine-update-bar" : undefined}
                style={{
                  height: "100%",
                  width: done ? "100%" : active ? "45%" : "0%",
                  borderRadius: 2,
                  background: done ? COLORS.success : COLORS.accent,
                  transition: "width 400ms ease",
                }}
              />
            </div>
            <span
              style={{
                fontFamily: SANS_FONT,
                fontSize: 11,
                color: active ? COLORS.textPrimary : COLORS.textMuted,
              }}
            >
              {step.label(targetVersion ?? "the new version")}
            </span>
          </div>
        );
      })}
    </div>
  );
}
