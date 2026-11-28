import React from "react";

import { CloudSlash, UserCircle } from "@phosphor-icons/react";

import type { BrowserAccountSnapshot } from "../../webclient/account/client";
import { Banner, type NoticeTone } from "../ui/notice";
import { BRAND } from "../../../shared/brand";

// ---------------------------------------------------------------------------
// What the hosted welcome surface says when it has no machines to list, and
// nothing when a signed-in account simply has none.
//
// Separate from the recents-row chrome because this is copy-and-account-state
// logic, not row rendering: `webZeroMachinesNotice` is a pure function of the
// account snapshot, and the two components below only render what it returns.
// ---------------------------------------------------------------------------

export type WebZeroMachinesNotice = {
  /** Stable hook for the reason the list is empty, for tests and telemetry. */
  kind: "loading" | "signed_out" | "unconfigured" | "unavailable";
  headline: string;
  detail: string | null;
  /**
   * What still works while this is broken. Only set where it is true and not
   * obvious — a failure that costs nothing should say so, and a failure that
   * costs something must not be dressed up as harmless.
   */
  reassurance?: string | null;
  action: { label: string; onSelect: () => void; busy: boolean } | null;
};

/**
 * What the hosted welcome surface says when it can list no machines, or null.
 *
 * A signed-in account with no computer is not a problem to report: Home is
 * the normal Home, and "Get started with ADE" leads to a first chat on ADE
 * Cloud. Zero rows can also mean the directory read failed or the session
 * lapsed, and telling those users their account is empty is a lie they cannot
 * act on. The account state, not the row count, decides which sentence they get.
 */
export function webZeroMachinesNotice(args: {
  account: BrowserAccountSnapshot;
  directoryLoading: boolean;
  /** Why the last retry from this surface failed, when one did. */
  retryError: string | null;
  onRetry: () => void;
  onSignIn: () => void;
}): WebZeroMachinesNotice | null {
  const { account, directoryLoading } = args;
  switch (account.state) {
    case "signed_in":
      return null;
    case "signed_out":
      return {
        kind: "signed_out",
        headline: "Sign in to see the machines on your account.",
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
        detail: account.message ?? `Your ${BRAND.NAME} account session expired.`,
        reassurance: "Your machines and their projects are untouched — signing in again brings the list back.",
        action: { label: "Sign in again", onSelect: args.onSignIn, busy: false },
      };
    case "loading":
      // Nothing has failed yet — the directory read is still in flight. Saying
      // "Couldn't load your machines" here reported a failure that had not
      // happened, and offered a Retry for a request already running.
      return {
        kind: "loading",
        headline: "Looking for your machines…",
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
        reassurance: "Only the list failed to load. Your machines and their projects are still running.",
        action: {
          label: directoryLoading ? "Retrying…" : "Retry",
          onSelect: args.onRetry,
          busy: directoryLoading,
        },
      };
  }
}

const ZERO_MACHINES_LOOK: Record<
  WebZeroMachinesNotice["kind"],
  { tone: NoticeTone; icon?: React.ReactNode }
> = {
  loading: { tone: "neutral" },
  signed_out: { tone: "warning", icon: <UserCircle size={13} weight="fill" /> },
  unconfigured: { tone: "neutral" },
  unavailable: { tone: "error", icon: <CloudSlash size={13} weight="fill" /> },
};

export function WebZeroMachines({ notice }: { notice: WebZeroMachinesNotice }) {
  const look = ZERO_MACHINES_LOOK[notice.kind];
  const lines = [notice.detail, notice.reassurance].filter((line): line is string => Boolean(line));
  return (
    <Banner
      testId="ade-web-machines-empty"
      layout="inline"
      style={{ marginTop: -4, maxWidth: 420, width: "100%" }}
      model={{
        id: `web-zero-machines-${notice.kind}`,
        tone: look.tone,
        icon: look.icon,
        busy: notice.kind === "loading",
        title: notice.headline,
        detail: lines.length > 0
          ? (
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {lines.map((line) => <span key={line}>{line}</span>)}
              </span>
            )
          : undefined,
        actions: notice.action
          ? [{
              label: notice.action.label,
              onClick: notice.action.onSelect,
              busy: notice.action.busy,
            }]
          : undefined,
      }}
    />
  );
}
