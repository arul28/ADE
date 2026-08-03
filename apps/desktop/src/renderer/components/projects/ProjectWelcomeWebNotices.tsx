import React from "react";

import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import type { BrowserAccountSnapshot } from "../../webclient/account/client";

// ---------------------------------------------------------------------------
// What the hosted welcome surface says when it has no machines to list, and
// what "Add project" can honestly offer there.
//
// Separate from the recents-row chrome because this is copy-and-account-state
// logic, not row rendering: `webZeroMachinesNotice` is a pure function of the
// account snapshot, and the two components below only render what it returns.
// ---------------------------------------------------------------------------

export type WebZeroMachinesNotice = {
  /** Stable hook for the reason the list is empty, for tests and telemetry. */
  kind: "loading" | "no_machines" | "signed_out" | "unconfigured" | "unavailable";
  headline: string;
  detail: string | null;
  action: { label: string; onSelect: () => void; busy: boolean } | null;
};

/**
 * What the hosted welcome surface says when it can list no machines.
 *
 * Zero rows can mean "this account really has no Macs" — but it just as easily
 * means the directory read failed or the session lapsed, and telling those
 * users their account is empty is a lie they cannot act on. The account state,
 * not the row count, decides which sentence they get.
 */
export function webZeroMachinesNotice(args: {
  account: BrowserAccountSnapshot;
  directoryLoading: boolean;
  /** Why the last retry from this surface failed, when one did. */
  retryError: string | null;
  onRetry: () => void;
  onSignIn: () => void;
}): WebZeroMachinesNotice {
  const { account, directoryLoading } = args;
  switch (account.state) {
    case "signed_in":
      return {
        kind: "no_machines",
        headline:
          "No Macs on this account yet. Open ADE on your Mac and sign in with the same account — it shows up here the moment it does.",
        detail: null,
        action: null,
      };
    case "signed_out":
      return {
        kind: "signed_out",
        headline: "Sign in to see the Macs on your account.",
        detail: account.message,
        action: { label: "Sign in", onSelect: args.onSignIn, busy: false },
      };
    case "unconfigured":
      return {
        kind: "unconfigured",
        headline:
          account.message ?? "Account sign-in isn't configured for this web client.",
        detail: null,
        action: null,
      };
    case "auth_expired":
      return {
        kind: "unavailable",
        headline: "Couldn't load your machines.",
        detail: account.message ?? "Your ADE account session expired.",
        action: { label: "Sign in again", onSelect: args.onSignIn, busy: false },
      };
    case "loading":
      // Nothing has failed yet — the directory read is still in flight. Saying
      // "Couldn't load your machines" here reported a failure that had not
      // happened, and offered a Retry for a request already running.
      return {
        kind: "loading",
        headline: "Looking for your Macs…",
        detail: null,
        action: null,
      };
    case "directory_unavailable":
      return {
        kind: "unavailable",
        headline: "Couldn't load your machines.",
        detail: args.retryError
          ?? account.message
          ?? "The machine directory didn't answer.",
        action: {
          label: directoryLoading ? "Retrying…" : "Retry",
          onSelect: args.onRetry,
          busy: directoryLoading,
        },
      };
  }
}

/**
 * What "Add project" can honestly offer on the hosted client.
 *
 * Adding a project is a filesystem act on the Mac that hosts it, and the web
 * adapter has none of the three routes the desktop flow needs: `chooseDirectory`
 * returns null (no native picker in a browser), `getDroppedPath` returns "", and
 * `createLocal`/`clone`/`getDefaultParentDir` are absent, so the fallback proxy
 * answers them with `Promise.resolve(null)` — the create form would read a null
 * parent directory and the clone would silently succeed at nothing. The host
 * *does* advertise a `projectActions` capability over sync (browse, create,
 * clone, GitHub repos — iOS already consumes it), so this is a wiring gap, not a
 * wall; until it is wired, say so instead of opening a flow that goes nowhere.
 */
export function WebAddProjectNotice({
  machineName,
  onDismiss,
}: {
  machineName: string | null;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-ade-web-add-project-notice="true"
      style={{
        marginTop: -4,
        maxWidth: 460,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: "12px 16px",
        borderRadius: 12,
        border: `1px solid ${COLORS.border}`,
        background: "rgba(255,255,255,0.03)",
        textAlign: "center",
        fontFamily: MONO_FONT,
        fontSize: 11,
        lineHeight: 1.6,
        color: COLORS.textSecondary,
      }}
    >
      <span>Projects are added on the Mac that hosts them.</span>
      <span style={{ color: COLORS.textDim }}>
        {machineName
          ? `Open ADE on ${machineName} to add, create, or clone one — it shows up here as soon as it does. ADE Web opens the projects that Mac already has.`
          : "Open ADE on your Mac to add, create, or clone one. ADE Web opens the projects that Mac already has."}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          ...outlineButton({ height: 28, padding: "0 14px", fontSize: 10 }),
          color: COLORS.textPrimary,
          border: `1px solid ${COLORS.border}`,
        }}
      >
        Got it
      </button>
    </div>
  );
}

export function WebZeroMachines({ notice }: { notice: WebZeroMachinesNotice }) {
  const failed = notice.kind === "unavailable";
  return (
    <div
      role={failed ? "alert" : undefined}
      data-ade-web-machines-empty={notice.kind}
      style={{
        marginTop: -4,
        maxWidth: 420,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        textAlign: "center",
        fontFamily: MONO_FONT,
        fontSize: 11,
        lineHeight: 1.6,
        color: failed ? COLORS.textSecondary : COLORS.textMuted,
      }}
    >
      <span>{notice.headline}</span>
      {notice.detail ? (
        <span style={{ color: COLORS.textDim }}>{notice.detail}</span>
      ) : null}
      {notice.action ? (
        <button
          type="button"
          onClick={notice.action.onSelect}
          disabled={notice.action.busy}
          style={{
            ...outlineButton({ height: 28, padding: "0 14px", fontSize: 10 }),
            color: COLORS.textPrimary,
            border: `1px solid ${COLORS.border}`,
            opacity: notice.action.busy ? 0.6 : 1,
          }}
        >
          {notice.action.label}
        </button>
      ) : null}
    </div>
  );
}
