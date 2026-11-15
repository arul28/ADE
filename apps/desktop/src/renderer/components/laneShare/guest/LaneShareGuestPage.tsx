import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, UsersThree } from "@phosphor-icons/react";
import type { LaneShareOpenResult, LaneShareReceivedEntry } from "../../../../shared/types/laneShare";
import { LANE_SHARE_GRANT_ID_PATTERN, LANE_SHARING_UNAVAILABLE, LANE_SHARING_UNAVAILABLE_MESSAGE } from "../../../../shared/laneShareDirectory";
import { Banner } from "../../ui/notice";
import { cn } from "../../ui/cn";
import { showToast } from "../../app/toast/toastStore";
import { formatLaneShareEnd, laneShareInviteExpired, laneSharePresetText } from "../laneShareModel";
import { useLaneShareList } from "../laneShareStore";
import { settingsRouteFor } from "../../../../shared/settingsManifest";
import { LaneShareGuestLaneTree } from "./LaneShareGuestShelf";
import {
  acceptLaneShare,
  laneShareGuestProblem,
  leaveLaneShare,
  loadLaneShareReceived,
  useLaneShareGuestStore,
  type LaneShareGuestProblem,
} from "./laneShareGuestStore";
import { LaneShareGuestView } from "./LaneShareGuestView";
import { LaneShareMeta, LaneShareState } from "../laneShareUi";
import { LANE_SHARE_GUEST_ROUTE, laneShareGuestPath } from "./laneShareGuestRoute";

/**
 * Lanes shared with me (`/shared`), a page of this machine, not of a project:
 * it works with no project open, and in the web client with no machine of
 * its own. `?grant=<id>` is where an invite link lands: signed out, sign in;
 * not this account's grant, say so; the owner's own link, open the owner's
 * lane; pending, the lane with one Accept strip; active, the lane itself,
 * on its newest chat.
 */

function InviteStrip({
  entry,
  onAccepted,
}: {
  entry: LaneShareReceivedEntry;
  onAccepted: (entry: LaneShareReceivedEntry) => void;
}) {
  const [busy, setBusy] = React.useState<"accept" | "decline" | null>(null);
  const [problem, setProblem] = React.useState<LaneShareGuestProblem | null>(null);
  const expired = laneShareInviteExpired(entry);
  const owner = entry.giverLabel ?? "The owner";
  const accept = async () => {
    setBusy("accept");
    setProblem(null);
    try {
      onAccepted(await acceptLaneShare(entry.grantId));
    } catch (error) {
      setProblem(laneShareGuestProblem(error));
    } finally {
      setBusy(null);
    }
  };
  const decline = async () => {
    setBusy("decline");
    try {
      await leaveLaneShare(entry.grantId);
      showToast({ tone: "success", title: "Invite declined" });
    } catch (error) {
      setProblem(laneShareGuestProblem(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="lane-share-invite">
      <div className="flex min-w-0 shrink-0 flex-col border-b border-fg/[0.06] px-4 py-2">
        <span className="min-w-0 truncate text-[13px] font-medium text-fg/90">{entry.laneLabel ?? "Shared lane"}</span>
        <LaneShareMeta parts={[`Shared by ${owner}`, entry.projectLabel, entry.endsAt != null ? formatLaneShareEnd(entry.endsAt) : null]} />
      </div>
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3 px-4 pt-6">
        <div className="ade-ls-invite-strip" data-testid="lane-share-accept-strip">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] text-fg/90">
              {expired ? "This invite expired" : `${owner} invited you to this lane`}
            </span>
            <span className="text-[12px] text-fg/60">
              {expired
                ? `Ask ${owner} to send it again.`
                : `${laneSharePresetText(entry.preset)} access. The lane stays on ${owner}'s computer, and ${owner} can stop sharing at any time.`}
            </span>
          </div>
          {!expired ? (
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" className="kit-btn" data-size="sm" disabled={busy != null} onClick={() => { void decline(); }}>Decline</button>
              <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={busy != null} onClick={() => { void accept(); }}>
                {busy === "accept" ? "Opening…" : "Accept and open"}
              </button>
            </div>
          ) : null}
        </div>
        {problem ? <Banner layout="inline" model={{ id: "lane-share-accept-problem", tone: "error", title: problem.message, report: false }} /> : null}
      </div>
    </div>
  );
}

/**
 * The owner opened its own invite link: open the shared lane in the Work tab
 * with a short note, or Settings › Sharing when this tab does not hold it.
 */
function OwnShareRedirect({ grantId }: { grantId: string }) {
  const navigate = useNavigate();
  const { key, entry } = useLaneShareList(null);
  const done = React.useRef(false);
  // The list starts loading after the first render; give it a few seconds
  // before this falls back to Settings (a tab that cannot read it never fills).
  const [waitedLong, setWaitedLong] = React.useState(false);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setWaitedLong(true), 5_000);
    return () => window.clearTimeout(timer);
  }, []);
  React.useEffect(() => {
    if (done.current) return;
    const share = entry?.shares.find((candidate) => candidate.grantId === grantId) ?? null;
    const stillLoading = entry?.status === "loading" || (key != null && entry == null);
    if (!share && stillLoading && !waitedLong) return;
    done.current = true;
    showToast({
      tone: "info",
      title: "This is your own share link",
      message: share
        ? `The people you invite use it to open this lane. ${share.receiverEmail ? `It is shared with ${share.receiverEmail}.` : ""}`.trim()
        : "The people you invite use it. Manage it here.",
    });
    navigate(share ? `/work?laneId=${encodeURIComponent(share.laneId)}` : settingsRouteFor("sharing.by-me"), { replace: true });
  }, [entry, grantId, key, navigate, waitedLong]);
  return <div className="p-6 text-[12px] text-fg/50">Opening your lane…</div>;
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
  /** `view=lane`: the lane's own page (start a chat), not its newest chat. */
  const laneView = params.get("view") === "lane";
  const received = useLaneShareGuestStore((state) => state.received);
  const receivedStatus = useLaneShareGuestStore((state) => state.receivedStatus);
  const receivedProblem = useLaneShareGuestStore((state) => state.receivedProblem);
  const [link, setLink] = React.useState<LinkState | null>(null);
  const [retries, setRetries] = React.useState(0);

  React.useEffect(() => {
    void loadLaneShareReceived();
  }, []);

  const listed = grantId ? (received ?? []).find((entry) => entry.grantId === grantId) ?? null : null;
  const active = React.useMemo(() => (received ?? []).filter((entry) => entry.state === "active"), [received]);
  const invites = React.useMemo(() => (received ?? []).filter((entry) => entry.state === "pending"), [received]);

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

  const select = React.useCallback((id: string | null, session: string | null = null, options: { lane?: boolean; replace?: boolean } = {}) => {
    const path = id ? laneShareGuestPath(id, session) : LANE_SHARE_GUEST_ROUTE;
    navigate(options.lane && id ? `${path}&view=lane` : path, options.replace ? { replace: true } : undefined);
  }, [navigate]);

  // Nothing picked: open the first shared lane (or invite) instead of a
  // "pick one" page.
  const first = active[0] ?? invites[0] ?? null;
  React.useEffect(() => {
    if (!grantId && first) select(first.grantId, null, { replace: true });
  }, [first, grantId, select]);

  // An open lane with no chat picked opens its newest chat.
  const sessions = useLaneShareGuestStore((state) => (listed?.state === "active" ? state.sessions[listed.grantId] : undefined));
  const newestChat = React.useMemo(
    () => (sessions ?? []).find((session) => session.kind === "chat") ?? null,
    [sessions],
  );
  React.useEffect(() => {
    if (listed?.state === "active" && !sessionId && !laneView && newestChat) {
      select(listed.grantId, newestChat.sessionId, { replace: true });
    }
  }, [laneView, listed?.grantId, listed?.state, newestChat, select, sessionId]);

  const signedOut = receivedProblem?.code === "signed_out" || receivedProblem?.code === "no_directory"
    || (link?.kind === "problem" && (link.problem.code === "signed_out" || link.problem.code === "no_directory"));

  // The directory has no lane sharing yet: one notice, asked again only on Try again.
  const unavailable = receivedProblem?.code === LANE_SHARING_UNAVAILABLE
    || (link?.kind === "problem" && link.problem.code === LANE_SHARING_UNAVAILABLE);

  const centered = (child: React.ReactNode) => <div className="mx-auto mt-8 w-full max-w-[560px] px-4">{child}</div>;
  const pendingListed = listed && (listed.state === "pending" || listed.state === "expired") ? listed : null;

  let main: React.ReactNode;
  if (unavailable) {
    main = centered(
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
      />,
    );
  } else if (signedOut) {
    main = centered(
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
      />,
    );
  } else if (listed?.state === "active") {
    main = (
      <LaneShareGuestView
        key={listed.grantId}
        entry={listed}
        sessionId={sessionId}
        onSelectSession={(next) => select(listed.grantId, next, { lane: next == null })}
      />
    );
  } else if (pendingListed) {
    main = <InviteStrip entry={pendingListed} onAccepted={(accepted) => select(accepted.grantId, null, { replace: true })} />;
  } else if (grantId && link?.kind === "loading") {
    main = <div className="p-6 text-[12px] text-fg/50">Opening the lane…</div>;
  } else if (grantId && link?.kind === "problem") {
    main = centered(<Banner layout="inline" model={{ id: "lane-share-link-problem", tone: "error", title: link.problem.message, report: false }} />);
  } else if (grantId && link?.kind === "result") {
    const { role, grant } = link.result;
    if (role === "giver") {
      main = <OwnShareRedirect grantId={grantId} />;
    } else if (role === "none" || !grant) {
      main = centered(
        <Banner
          layout="inline"
          model={{
            id: "lane-share-not-yours",
            tone: "warning",
            title: "This invite is for another account",
            detail: "Sign in with the account the invite went to, then open the link again.",
            report: false,
            actions: [{ label: "Switch account", onClick: () => navigate("/account") }],
          }}
        />,
      );
    } else if (grant.state === "pending" || grant.state === "expired") {
      main = <InviteStrip entry={grant} onAccepted={(accepted) => select(accepted.grantId, null, { replace: true })} />;
    } else if (grant.state === "active") {
      // Accepted on another device: the list catches up.
      main = <div className="p-6 text-[12px] text-fg/50">Opening the lane…</div>;
    } else {
      main = centered(
        <Banner layout="inline" model={{ id: "lane-share-closed", tone: "neutral", title: "This share has ended", detail: "Ask the owner for a new invite.", report: false }} />,
      );
    }
  } else {
    main = (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <UsersThree size={22} className="text-fg/30" />
        <div className="text-[13px] text-fg/75">{receivedStatus === "loading" ? "Loading…" : "No shared lanes yet"}</div>
        {receivedStatus !== "loading" ? (
          <div className="max-w-[340px] text-[12px] text-fg/50">When someone shares a lane with you, ADE emails you a link. It opens the lane here.</div>
        ) : null}
      </div>
    );
  }

  const selectedTree = grantId ? { grantId, sessionId } : null;
  return (
    <div className="flex h-full min-h-0 w-full" data-testid="lane-share-guest-page">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-fg/[0.06] max-md:hidden">
        <div className="flex items-center gap-1 px-2 pb-1 pt-2">
          <button
            type="button"
            className="kit-icon-btn"
            aria-label="Back"
            title="Back"
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}
          >
            <ArrowLeft size={14} />
          </button>
          <h2 className="ade-ls-pane-title min-w-0 flex-1">Shared with me</h2>
        </div>
        {receivedProblem && !signedOut && !unavailable ? (
          <div className="px-3 pb-2 text-[11.5px] text-fg/60">{receivedProblem.message}</div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-3">
          {invites.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="px-2 pb-0.5 text-[11px] text-fg/45">Invites</span>
              {invites.map((entry) => (
                <InviteRow key={entry.grantId} entry={entry} selected={entry.grantId === grantId} onSelect={() => select(entry.grantId)} />
              ))}
            </div>
          ) : null}
          {active.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-0.5">
              {invites.length > 0 ? <span className="px-2 pb-0.5 text-[11px] text-fg/45">Lanes</span> : null}
              {active.map((entry) => (
                <LaneShareGuestLaneTree
                  key={entry.grantId}
                  entry={entry}
                  selected={selectedTree}
                  defaultExpanded={entry.grantId === grantId}
                  onSelect={(id, session) => select(id, session, { lane: session == null })}
                />
              ))}
            </div>
          ) : null}
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1">{main}</main>
    </div>
  );
}

/** One invite in the list: the lane, who sent it, and that it waits for an answer. */
function InviteRow({ entry, selected, onSelect }: { entry: LaneShareReceivedEntry; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-fg/[0.05]",
        selected && "bg-fg/[0.07]",
      )}
      onClick={onSelect}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate text-[12px] text-fg/85" title={entry.laneLabel ?? undefined}>{entry.laneLabel ?? "Shared lane"}</span>
        <span className="min-w-0 truncate text-[10.5px] text-fg/45">From {entry.giverLabel ?? "another account"}</span>
      </span>
      <LaneShareState label={laneShareInviteExpired(entry) ? "Expired" : "New"} tone={laneShareInviteExpired(entry) ? null : "ok"} />
    </button>
  );
}
