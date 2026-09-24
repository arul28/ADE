import React from "react";

import { CloudSlash, Desktop, UserCircle } from "@phosphor-icons/react";

import type { BrowserAccountSnapshot } from "../../webclient/account/client";
import { Banner, type NoticeTone } from "../ui/notice";

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
  /**
   * What still works while this is broken. Only set where it is true and not
   * obvious — a failure that costs nothing should say so, and a failure that
   * costs something must not be dressed up as harmless.
   */
  reassurance?: string | null;
  action: { label: string; onSelect: () => void; busy: boolean } | null;
};

/**
 * What the hosted welcome surface says when it can list no machines.
 *
 * Zero rows can mean "this account really has no machines" — but it just as easily
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
          "No machines on this account yet. Open ADE on a computer and sign in with the same account — it shows up here the moment it does.",
        detail: null,
        action: null,
      };
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
        detail: account.message ?? "Your ADE account session expired.",
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

/**
 * What "Add project" can honestly offer on the hosted client.
 *
 * Adding a project is a filesystem act on the machine that hosts it, and the web
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
    <Banner
      testId="ade-web-add-project-notice"
      layout="inline"
      style={{ marginTop: -4, maxWidth: 460, width: "100%" }}
      model={{
        id: "web-add-project",
        tone: "info",
        title: "Projects are added on the machine that hosts them.",
        detail: machineName
          ? `Open ADE on ${machineName} to add, create, or clone one — it shows up here as soon as it does. ADE Web opens the projects that machine already has.`
          : "Open ADE on the host machine to add, create, or clone one. ADE Web opens the projects that machine already has.",
        actions: [{ label: "Got it", onClick: onDismiss }],
      }}
    />
  );
}

const ZERO_MACHINES_LOOK: Record<
  WebZeroMachinesNotice["kind"],
  { tone: NoticeTone; icon?: React.ReactNode }
> = {
  loading: { tone: "neutral" },
  no_machines: { tone: "info", icon: <Desktop size={13} weight="fill" /> },
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
