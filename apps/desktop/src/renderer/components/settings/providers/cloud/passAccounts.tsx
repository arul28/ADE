/**
 * Claude pass accounts on a cloud computer's own page. On a cloud computer,
 * each Claude pass the account holds is a Claude account (`pass-<12 hex>`,
 * `pass-legacy`). It is not signed in or out there: ADE Cloud owns it. So
 * its card shows the pass's state and a way to ADE Cloud's Claude page.
 *
 * The pass rows come from that computer's own status read, only when its
 * accounts hold a pass account: on open and on `providerLogins.onChanged`,
 * keyed on the pin's key. No timer.
 */
import { useMemo } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { OpenProjectBinding } from "../../../../../shared/types";
import { COLORS, SANS_FONT } from "../../../lanes/laneDesignTokens";
import { adeCloudSettingsSearch } from "../../SettingsMachineScope";
import { stateLine, type PassLine } from "./adeCloudClaudeModel";
import { passTitle, readClaudePasses, type CloudPassRow } from "./adeCloudSignInModel";
import { usePinnedProviderLoginStatus } from "./usePinnedProviderLoginStatus";


/** The pass rows of the page's computer, by key; empty while `enabled` is false or before the read. */
export function useComputerPassRows(enabled: boolean, pin: OpenProjectBinding | null): ReadonlyMap<string, CloudPassRow> {
  const { status } = usePinnedProviderLoginStatus({
    provider: "claude",
    pin,
    enabled,
    warning: "[providers] reading this computer's Claude passes failed",
  });
  return useMemo(
    () => (enabled && status ? new Map(readClaudePasses(status).map((row) => [row.key, row])) : EMPTY),
    [enabled, status],
  );
}

const EMPTY: ReadonlyMap<string, CloudPassRow> = new Map();

/** The card's name for a pass with no email: as on ADE Cloud's Claude page. */
export function passAccountTitle(row: CloudPassRow | undefined, now: number): string {
  if (!row) return "Claude pass";
  if (row.unreadable) return "Claude pass ADE can't read";
  return passTitle(row, now);
}

/**
 * The pass's state in one line (P5–P8), in place of a sign-in's end date: a
 * pass ends only when Claude refuses it, and its date is often an estimate.
 */
export function passAccountLine(row: CloudPassRow | undefined, now: number): PassLine {
  if (!row) return { text: "Claude pass", tone: null };
  if (row.unreadable) return { text: "ADE can't read this Claude pass", tone: "warn" };
  const line = stateLine(row, now, { short: true });
  return line.text ? line : { text: "Claude pass", tone: null };
}

/** "Claude pass · Change it on ADE Cloud": the pass card's way to ADE Cloud's Claude page. */
export function AdeCloudPassLink({ state }: { state: PassLine }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const color = state.tone === "crit" ? COLORS.danger : state.tone === "warn" ? COLORS.warning : COLORS.textDim;
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, fontFamily: SANS_FONT, color }}>{state.text}</span>
      <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
        Claude pass ·{" "}
        <button
          type="button"
          onClick={() => {
            const search = adeCloudSettingsSearch({ base: searchParams, provider: "claude" });
            navigate({ pathname: location.pathname, search, hash: "#ai-provider-claude" }, { replace: true });
          }}
          style={{ padding: 0, border: 0, background: "transparent", color: "var(--color-accent)", font: "inherit", cursor: "pointer" }}
        >
          Change it on ADE Cloud
        </button>
      </span>
    </span>
  );
}
