import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { UsersThree } from "@phosphor-icons/react";
import type { LaneShareOpenResult, LaneShareReceivedEntry } from "../../../../shared/types/laneShare";
import { LANE_SHARE_GRANT_ID_PATTERN, LANE_SHARING_UNAVAILABLE, LANE_SHARING_UNAVAILABLE_MESSAGE } from "../../../../shared/laneShareDirectory";
import { Banner } from "../../ui/notice";
import { cn } from "../../ui/cn";
import { showToast } from "../../app/toast/toastStore";
import { formatLaneShareEnd, laneShareGrantStateLabel, laneShareInviteExpired, laneSharePresetText, LANE_SHARE_RISK_LABELS } from "../laneShareModel";
import {
  acceptLaneShare,
  laneShareGuestProblem,
  leaveLaneShare,
  loadLaneShareReceived,
  useLaneShareGuestStore,
  type LaneShareGuestProblem,
} from "./laneShareGuestStore";
import { LaneShareGuestView } from "./LaneShareGuestView";
import { LaneShareMeta } from "../laneShareUi";
import { LANE_SHARE_GUEST_ROUTE, laneShareGuestPath } from "./laneShareGuestRoute";

/**
 * Lanes shared with me (`/shared`), a page of this machine, not of a project:
 * it works with no project open, and in the web client with no machine of
 * its own. `?grant=<id>` is where an invite link lands (signed out: sign in;
 * not this account's grant: say so; pending: accept; active: open).
 */



function AcceptCard({
  entry,
  onAccepted,
}: {
  entry: LaneShareReceivedEntry;
  onAccepted: (entry: LaneShareReceivedEntry) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<LaneShareGuestProblem | null>(null);
  const expired = laneShareInviteExpired(entry);
  const accept = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const grant = await acceptLaneShare(entry.grantId);
      showToast({ tone: "success", title: "Lane added to Shared with me" });
      onAccepted(grant);
    } catch (error) {
      setProblem(laneShareGuestProblem(error));
    } finally {
      setBusy(false);
    }
  };
  const decline = async () => {
    setBusy(true);
    try {
      await leaveLaneShare(entry.grantId);
      showToast({ tone: "success", title: "Invite declined" });
    } catch (error) {
      setProblem(laneShareGuestProblem(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kit-panel mx-auto mt-8 flex w-full max-w-[520px] flex-col gap-3 p-5" data-testid="lane-share-accept-card">
      <div className="flex flex-col gap-1">
        <span className="text-[14px] font-medium text-fg/90">
          {entry.giverLabel ?? "Someone"} shares a lane with you
        </span>
        <span className="min-w-0 break-words text-[12.5px] text-fg/70">
          {entry.laneLabel ?? "A lane"}
          {entry.projectLabel ? ` in ${entry.projectLabel}` : ""}
        </span>
        <LaneShareMeta
          parts={[
            `${laneSharePresetText(entry.preset)} access`,
            entry.risk ? <span key="risk">{LANE_SHARE_RISK_LABELS[entry.risk]}</span> : null,
            formatLaneShareEnd(entry.endsAt),
          ]}
        />
      </div>
      {expired ? (
        <div className="text-[12.5px] text-fg/70">This invite expired. Ask {entry.giverLabel ?? "the owner"} to send it again.</div>
      ) : (
        <div className="text-[12px] text-fg/60">
          The lane stays on {entry.giverLabel ?? "the owner"}'s computer. You see and do only what the owner allows, and the owner can stop it at any time.
        </div>
      )}
      {problem ? <Banner layout="inline" model={{ id: "lane-share-accept-problem", tone: "error", title: problem.message, report: false }} /> : null}
      {!expired ? (
        <div className="flex items-center gap-2">
          <button type="button" className="kit-btn kit-btn-primary" disabled={busy} onClick={() => { void accept(); }}>Accept</button>
          <button type="button" className="kit-btn" disabled={busy} onClick={() => { void decline(); }}>Decline</button>
        </div>
      ) : null}
    </div>
  );
}

type LinkState =
  | { kind: "loading" }
  | { kind: "problem"; problem: LaneShareGuestProblem }
  | { kind: "result"; result: LaneShareOpenResult };

export function LaneShareGuestPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = React.useMemo(() => new URLSearchParams(location.search), [location.search]);
  const rawGrant = params.get("grant")?.trim() ?? "";
  const grantId = LANE_SHARE_GRANT_ID_PATTERN.test(rawGrant) ? rawGrant : null;
  const sessionId = grantId ? params.get("session") : null;
  const received = useLaneShareGuestStore((state) => state.received);
  const receivedStatus = useLaneShareGuestStore((state) => state.receivedStatus);
  const receivedProblem = useLaneShareGuestStore((state) => state.receivedProblem);
  const guestStates = useLaneShareGuestStore((state) => state.guestStates);
  // The host's current lane name once a connection read it: a rename follows.
  const liveLaneNames = React.useMemo(() => {
    const names: Record<string, string> = {};
    for (const [grantId, guestState] of Object.entries(guestStates)) {
      const name = guestState?.lane?.name;
      if (name) names[grantId] = name;
    }
    return names;
  }, [guestStates]);
  const [link, setLink] = React.useState<LinkState | null>(null);
  const [retries, setRetries] = React.useState(0);

  React.useEffect(() => {
    void loadLaneShareReceived();
  }, []);

  const listed = grantId ? (received ?? []).find((entry) => entry.grantId === grantId) ?? null : null;

  // A link to a grant this list does not show as active: ask the directory.
  React.useEffect(() => {
    if (!grantId || listed?.state === "active") {
      setLink(null);
      return;
    }
    let cancelled = false;
    setLink({ kind: "loading" });
    void window.ade.laneShareGuest.open({ grantId }).then(
      (result) => {
        if (cancelled) return;
        setLink({ kind: "result", result });
        // Accepted on another device of this account: the list catches up.
        if (result.grant?.state === "active") void loadLaneShareReceived({ force: true });
      },
      (error) => { if (!cancelled) setLink({ kind: "problem", problem: laneShareGuestProblem(error) }); },
    );
    return () => {
      cancelled = true;
    };
  }, [grantId, listed?.state, retries]);

  const select = (id: string | null, session: string | null = null) => {
    navigate(id ? laneShareGuestPath(id, session) : LANE_SHARE_GUEST_ROUTE);
  };

  const rows = (received ?? []).filter((entry) => entry.state === "active" || entry.state === "pending");
  const signedOut = receivedProblem?.code === "signed_out" || receivedProblem?.code === "no_directory"
    || (link?.kind === "problem" && (link.problem.code === "signed_out" || link.problem.code === "no_directory"));

  // The directory has no lane sharing yet: one notice, asked again only on Try again.
  const unavailable = receivedProblem?.code === LANE_SHARING_UNAVAILABLE
    || (link?.kind === "problem" && link.problem.code === LANE_SHARING_UNAVAILABLE);

  let main: React.ReactNode;
  if (unavailable) {
    main = (
      <div className="mx-auto mt-8 w-full max-w-[520px]">
        <Banner
          layout="inline"
          model={{
            id: "lane-sharing-unavailable",
            tone: "info",
            title: LANE_SHARING_UNAVAILABLE_MESSAGE,
            report: false,
            actions: [{
              label: "Try again",
              onClick: () => {
                void loadLaneShareReceived({ force: true, retry: true });
                if (grantId) setRetries((count) => count + 1);
              },
            }],
          }}
        />
      </div>
    );
  } else if (signedOut) {
    main = (
      <div className="mx-auto mt-8 w-full max-w-[520px]">
        <Banner
          layout="inline"
          model={{
            id: "lane-share-sign-in",
            tone: "info",
            title: "Sign in to your ADE account first",
            detail: "Lanes shared with you are tied to your account. After you sign in, open the link again.",
            report: false,
            actions: [{ label: "Sign in", onClick: () => navigate("/account") }],
          }}
        />
      </div>
    );
  } else if (listed?.state === "active") {
    main = (
      <LaneShareGuestView
        key={listed.grantId}
        entry={listed}
        sessionId={sessionId}
        onSelectSession={(next) => select(listed.grantId, next)}
        onClose={() => select(null)}
      />
    );
  } else if (grantId && link?.kind === "loading") {
    main = <div className="p-6 text-[12px] text-fg/50">Opening the share…</div>;
  } else if (grantId && link?.kind === "problem") {
    main = (
      <div className="mx-auto mt-8 w-full max-w-[520px]">
        <Banner layout="inline" model={{ id: "lane-share-link-problem", tone: "error", title: link.problem.message, report: false }} />
      </div>
    );
  } else if (grantId && link?.kind === "result") {
    const { role, grant } = link.result;
    if (role === "none" || !grant) {
      main = (
        <div className="mx-auto mt-8 w-full max-w-[520px]">
          <Banner
            layout="inline"
            model={{
              id: "lane-share-not-yours",
              tone: role === "giver" ? "info" : "warning",
              title: role === "giver" ? "This is your own share" : "This share is not for this account",
              detail: role === "giver"
                ? "Manage it in Settings › Sharing."
                : "If the invite went to another email address, sign in with that account and open the link again.",
              report: false,
            }}
          />
        </div>
      );
    } else if (grant.state === "pending" || grant.state === "expired") {
      main = <AcceptCard entry={grant} onAccepted={(accepted) => select(accepted.grantId)} />;
    } else if (grant.state === "active") {
      // Accepted on another device: the list catches up.
      main = <div className="p-6 text-[12px] text-fg/50">Opening the share…</div>;
    } else {
      main = (
        <div className="mx-auto mt-8 w-full max-w-[520px]">
          <Banner layout="inline" model={{ id: "lane-share-closed", tone: "neutral", title: "This share has ended", detail: "Ask the owner for a new invite.", report: false }} />
        </div>
      );
    }
  } else {
    main = (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <UsersThree size={20} className="text-fg/35" />
        <div className="text-[12.5px] text-fg/65">
          {receivedStatus === "loading" ? "Loading…" : rows.length === 0 ? "Nobody shares a lane with you yet." : "Pick a shared lane."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full" data-testid="lane-share-guest-page">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-fg/[0.06]">
        <h2 className="ade-ls-pane-title px-3 pb-2 pt-3">Shared with me</h2>
        {receivedProblem && !signedOut && !unavailable ? (
          <div className="px-3 pb-2 text-[11.5px] text-fg/60">{receivedProblem.message}</div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {rows.map((entry) => (
            <button
              key={entry.grantId}
              type="button"
              className={cn(
                "flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-fg/[0.05]",
                entry.grantId === grantId && "bg-fg/[0.07]",
              )}
              onClick={() => select(entry.grantId)}
            >
              <span className="min-w-0 truncate text-[12.5px] text-fg/85" title={liveLaneNames[entry.grantId] ?? entry.laneLabel ?? undefined}>
                {liveLaneNames[entry.grantId] ?? entry.laneLabel ?? "Shared lane"}
              </span>
              <span className="min-w-0 truncate text-[11px] text-fg/50">
                From {entry.giverLabel ?? "another account"} · {laneShareGrantStateLabel(entry).label}
              </span>
            </button>
          ))}
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1">{main}</main>
    </div>
  );
}
