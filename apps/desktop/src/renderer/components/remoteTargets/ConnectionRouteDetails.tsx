import type { RemoteRuntimeConnectionAttempt } from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";

const ROUTE_LABELS: Record<RemoteRuntimeConnectionAttempt["kind"], string> = {
  lan: "Local network",
  tailnet: "Tailscale",
  relay: "ADE relay",
  ssh: "SSH",
};

/**
 * Plain-word names for the reasons the main process reports. The headline says
 * one thing; this list is where a curious (or supporting) user sees which route
 * hit which wall.
 */
const FAILURE_LABELS: Record<
  NonNullable<RemoteRuntimeConnectionAttempt["failure"]>,
  string
> = {
  unreachable: "no answer",
  timeout: "timed out",
  authentication: "not signed in",
  pairing: "pairing rejected",
  identity: "wrong machine answered",
  superseded: "another route won",
  capability: "unsupported",
  protocol: "version mismatch",
  unknown: "failed",
};

function safeDiagnosticHost(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  if (!normalized) return "Unknown host";
  try {
    const url = new URL(normalized.includes("://") ? normalized : `ws://${normalized}`);
    return url.host || "Unknown host";
  } catch {
    return normalized.split(/[/?#]/, 1)[0] || "Unknown host";
  }
}

/**
 * Everything the headline deliberately leaves out — every route tried, the host
 * it dialled, how long it took, and the diagnostic ID to quote in a bug report.
 * Collapsed by default: nobody debugging their Wi-Fi needs an IPv6 literal in
 * their face.
 */
export function ConnectionRouteDetails({
  attempts,
  correlationId,
  omittedAttemptCount = 0,
}: {
  attempts: RemoteRuntimeConnectionAttempt[];
  correlationId: string | null;
  omittedAttemptCount?: number;
}) {
  if (attempts.length === 0 && !correlationId) return null;
  return (
    <details
      style={{
        borderTop: `1px solid ${COLORS.border}`,
        paddingTop: 7,
        color: COLORS.textMuted,
        fontFamily: SANS_FONT,
        fontSize: 11,
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          color: COLORS.textSecondary,
          fontWeight: 650,
          userSelect: "none",
        }}
      >
        Details
      </summary>
      <div style={{ display: "grid", gap: 5, marginTop: 7 }}>
        {attempts.slice(0, 8).map((attempt, index) => {
          const outcome = attempt.outcome === "connected"
            ? "Connected"
            : attempt.outcome === "skipped"
              ? "Skipped"
              : `Failed${attempt.failure ? ` — ${FAILURE_LABELS[attempt.failure]}` : ""}`;
          return (
            <div
              key={`${attempt.kind}:${attempt.startedAt}:${index}`}
              style={{
                display: "grid",
                gridTemplateColumns: "max-content minmax(0, 1fr)",
                columnGap: 8,
              }}
            >
              <span style={{ color: COLORS.textSecondary, fontWeight: 650 }}>
                {ROUTE_LABELS[attempt.kind]}
              </span>
              <span>
                {`${safeDiagnosticHost(attempt.host)} · ${Math.max(0, Math.round(attempt.durationMs))}ms · ${outcome}`}
              </span>
            </div>
          );
        })}
        {omittedAttemptCount > 0 ? (
          <div>{`${omittedAttemptCount} more route${omittedAttemptCount === 1 ? "" : "s"} not shown`}</div>
        ) : null}
        {correlationId ? (
          <div>
            <span style={{ color: COLORS.textSecondary, fontWeight: 650 }}>
              Diagnostic ID
            </span>
            {" "}
            <code style={{ userSelect: "text" }}>{correlationId}</code>
          </div>
        ) : null}
      </div>
    </details>
  );
}
