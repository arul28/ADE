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
import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { OpenProjectBinding } from "../../../../../shared/types";
import { COLORS, SANS_FONT } from "../../../lanes/laneDesignTokens";
import { ADE_CLOUD_PLACE_ID } from "../../SettingsMachineScope";
import { readClaudePasses, shortDate, type CloudPassRow } from "./adeCloudSignInModel";

const PASS_ACCOUNT_PREFIX = "pass-";

/** A Claude account that is a pass on this computer (ADE Cloud made it). */
export function isPassAccountId(id: string): boolean {
  return id.startsWith(PASS_ACCOUNT_PREFIX) && id.length > PASS_ACCOUNT_PREFIX.length;
}

/** The pass key of a pass account: `pass-<12 hex>` ↔ `claude-pass/<12 hex>`, `pass-legacy` ↔ `claude-pass/legacy`. */
export function passKeyForAccountId(id: string): string | null {
  return isPassAccountId(id) ? `claude-pass/${id.slice(PASS_ACCOUNT_PREFIX.length)}` : null;
}

/** The pass rows of the page's computer, by key; empty while `enabled` is false or before the read. */
export function useComputerPassRows(enabled: boolean, pin: OpenProjectBinding | null): ReadonlyMap<string, CloudPassRow> {
  const pinKey = pin?.key ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const [read, setRead] = useState<{ key: string | null; rows: ReadonlyMap<string, CloudPassRow> } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const off = window.ade?.providerLogins?.onChanged?.(() => setTick((value) => value + 1));
    return () => off?.();
  }, [enabled]);
  useEffect(() => {
    const status = window.ade?.providerLogins?.status;
    if (!enabled || typeof status !== "function") return undefined;
    let cancelled = false;
    status({ provider: "claude" }, pinRef.current).then(
      (next) => {
        if (cancelled) return;
        setRead({ key: pinKey, rows: new Map(readClaudePasses(next).map((row) => [row.key, row])) });
      },
      (error: unknown) => console.warn("[providers] reading this computer's Claude passes failed", error),
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, pinKey, tick]);
  return read && read.key === pinKey ? read.rows : EMPTY;
}

const EMPTY: ReadonlyMap<string, CloudPassRow> = new Map();

/** The card's name for a pass with no email: as on ADE Cloud's Claude page. */
export function passAccountTitle(row: CloudPassRow | undefined, now: number): string {
  if (!row) return "Claude pass";
  if (row.unreadable) return "Claude pass ADE can't read";
  return row.email ?? `Claude pass from ${shortDate(row.createdAt, now)}`;
}

/**
 * The pass's state in one line (P5–P8), in place of a sign-in's end date: a
 * pass ends only when Claude refuses it, and its date is often an estimate.
 */
export function passAccountLine(row: CloudPassRow | undefined, now: number): { text: string; tone: "warn" | "crit" | null } {
  if (!row) return { text: "Claude pass", tone: null };
  if (row.unreadable) return { text: "ADE can't read this Claude pass", tone: "warn" };
  switch (row.state) {
    case "ended":
      return { text: `Claude ended this pass${row.endedAt != null ? ` on ${shortDate(row.endedAt, now)}` : ""}`, tone: "crit" };
    case "estimate_passed":
      return { text: "Its expected end date has passed", tone: "warn" };
    case "ending_soon": {
      const days = Math.max(0, Math.round(row.endsInDays));
      return { text: `Ends in ${days} day${days === 1 ? "" : "s"}`, tone: "warn" };
    }
    default:
      if (row.expiresAt == null) return { text: "Claude pass", tone: null };
      return { text: `${row.expiresAtSource === "claude" ? "Ends on" : "Ends around"} ${shortDate(row.expiresAt, now)}`, tone: null };
  }
}

/** "Claude pass · Change it on ADE Cloud": the pass card's way to ADE Cloud's Claude page. */
export function AdeCloudPassLink({ state }: { state: { text: string; tone: "warn" | "crit" | null } }) {
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
            const next = new URLSearchParams(searchParams);
            next.set("machine", ADE_CLOUD_PLACE_ID);
            next.set("provider", "claude");
            next.delete("harnesses");
            navigate({ pathname: location.pathname, search: `?${next.toString()}`, hash: "#ai-provider-claude" }, { replace: true });
          }}
          style={{ padding: 0, border: 0, background: "transparent", color: "var(--color-accent)", font: "inherit", cursor: "pointer" }}
        >
          Change it on ADE Cloud
        </button>
      </span>
    </span>
  );
}
