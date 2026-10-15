/**
 * What the Muse Settings sections share: the row and field styles, the section
 * header, the inline error notice, and the typed `run` that every call goes
 * through.
 */
import React from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, SECTION_LABEL_STYLE, outlineButton } from "../../../../lanes/laneDesignTokens";
import { Banner } from "../../../../ui/notice";
import type {
  MuseSettingsRequest,
  MuseSettingsResult,
  MuseSettingsSection,
} from "../../../../../../shared/museSettings";

export const TEXT_MUTED: React.CSSProperties = { fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 };
export const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 12,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  padding: "5px 0",
  borderTop: `1px solid ${COLORS.borderMuted}`,
  minWidth: 0,
};
export const FIELD: React.CSSProperties = {
  background: COLORS.cardBg,
  border: `1px solid ${COLORS.border}`,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  outline: "none",
  minWidth: 0,
};
export const SMALL_BUTTON = outlineButton({ height: 24, padding: "0 9px", fontSize: 11 });
export const DIVIDER_STYLE: React.CSSProperties = { borderTop: `1px solid ${COLORS.border}`, margin: "4px 0" };

/**
 * A type guard for a string union. `isOneOf<Kind>(["a", "b"])` checks each
 * listed value against `Kind`, so a value that is not in the union fails to compile.
 */
export function isOneOf<T extends string>(values: readonly T[]): (value: string) => value is T {
  const allowed: ReadonlySet<string> = new Set<string>(values);
  return (value: string): value is T => allowed.has(value);
}

/** One call into the Settings-owned `muse serve` host, typed by its request. */
export type MuseRun = <R extends MuseSettingsRequest>(request: R) => Promise<MuseSettingsResult<R["kind"]>>;

/** A Muse error, shown as Muse words it. Renders nothing when there is no error. */
export function ErrorNotice({ id, message }: { id: string; message: string | null | undefined }) {
  return message ? <Banner layout="inline" model={{ id, tone: "error", title: message }} /> : null;
}

export function SectionError<T>({ id, section }: { id: string; section: MuseSettingsSection<T> }) {
  return <ErrorNotice id={id} message={section.ok ? null : section.error} />;
}

export function SectionHeader({ title, onRefresh, busy }: { title: string; onRefresh?: () => void; busy?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={SECTION_LABEL_STYLE}>{title}</div>
      {onRefresh ? (
        <button type="button" style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12 })} disabled={busy} onClick={onRefresh}>
          <ArrowsClockwise size={11} weight="bold" /> {busy ? "Refreshing…" : "Refresh"}
        </button>
      ) : null}
    </div>
  );
}
