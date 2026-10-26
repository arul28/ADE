import type { CSSProperties, ReactNode } from "react";
import { CheckCircle, MinusCircle, WarningCircle, XCircle } from "@phosphor-icons/react";
import { SANS_FONT } from "../lanes/laneDesignTokens";

/**
 * One row grammar for every connection check: a state icon, the part's name,
 * one line of what was found, and a short result on the right. The raw error
 * goes in the row's tooltip; only a row that needs something done gets a
 * second line, with the fix. Columns line up across rows because every row's
 * cells sit in one grid.
 */

export type DiagnosisState = "ok" | "warning" | "failed" | "off";

const STATE_COLOR: Record<DiagnosisState, string> = {
  ok: "var(--kit-ok)",
  warning: "var(--kit-warn)",
  failed: "var(--kit-crit)",
  off: "var(--kit-text-3)",
};

export function DiagnosisIcon({ state, size = 14 }: { state: DiagnosisState; size?: number }) {
  const color = STATE_COLOR[state];
  switch (state) {
    case "ok":
      return <CheckCircle size={size} weight="fill" color={color} aria-label="Working" />;
    case "warning":
      return <WarningCircle size={size} weight="fill" color={color} aria-label="Needs attention" />;
    case "failed":
      return <XCircle size={size} weight="fill" color={color} aria-label="Not working" />;
    default:
      return <MinusCircle size={size} weight="bold" color={color} aria-label="Not set up" />;
  }
}

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "14px max-content minmax(0,1fr) auto",
  columnGap: 10,
  rowGap: 7,
  alignItems: "center",
  fontFamily: SANS_FONT,
  fontSize: 12,
  lineHeight: "18px",
};

const oneLine: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function DiagnosisList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="list" aria-label={label} style={gridStyle}>
      {children}
    </div>
  );
}

export function DiagnosisRow({
  state,
  label,
  detail,
  meta,
  fix,
  tooltip,
}: {
  state: DiagnosisState;
  label: string;
  detail: string;
  /** Right column: a latency or a two-word result. */
  meta?: string | null;
  /** Shown under the row only when it is not working. */
  fix?: string | null;
  /** The full text, including any raw error. */
  tooltip?: string;
}) {
  // A latency reads as a figure; a reason ("Nothing answered") reads as words.
  const metaIsNumber = typeof meta === "string" && /^\d/.test(meta);
  const metaColor = state === "failed" ? "var(--kit-crit)" : state === "warning" ? "var(--kit-warn)" : "var(--kit-text-3)";
  return (
    <div role="listitem" title={tooltip ?? detail} style={{ display: "contents" }}>
      <span style={{ display: "flex" }}><DiagnosisIcon state={state} /></span>
      <span style={{ ...oneLine, color: "var(--color-fg)", fontWeight: 500 }}>{label}</span>
      <span style={{ ...oneLine, color: "var(--kit-text-2)" }}>{detail}</span>
      <span
        className={metaIsNumber ? "kit-num" : undefined}
        style={{ ...oneLine, color: metaColor, fontSize: metaIsNumber ? 11.5 : 12, textAlign: "right" }}
      >
        {meta ?? ""}
      </span>
      {fix && state !== "ok" && state !== "off" ? (
        <span
          style={{
            gridColumn: "2 / -1",
            marginTop: -4,
            color: "var(--kit-text-3)",
            fontSize: 11.5,
            lineHeight: "16px",
          }}
        >
          {fix}
        </span>
      ) : null}
    </div>
  );
}

/** A quiet section label with an optional control on the right. */
export function DiagnosisSectionHead({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 24 }}>
      <span className="kit-eyebrow" style={{ ...oneLine, flex: 1 }}>{label}</span>
      {action}
    </div>
  );
}

/** The one-sentence answer at the top, with what to do under it. */
export function DiagnosisVerdict({
  state,
  title,
  fix,
}: {
  state: DiagnosisState;
  title: string;
  fix?: string | null;
}) {
  return (
    <div role="status" style={{ display: "flex", gap: 10, alignItems: "flex-start", fontFamily: SANS_FONT }}>
      <span style={{ display: "flex", marginTop: 1 }}><DiagnosisIcon state={state} size={16} /></span>
      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span style={{ color: "var(--color-fg)", fontSize: 13, fontWeight: 600, lineHeight: "18px" }}>{title}</span>
        {fix ? <span style={{ color: "var(--kit-text-2)", fontSize: 12, lineHeight: "17px" }}>{fix}</span> : null}
      </span>
    </div>
  );
}
