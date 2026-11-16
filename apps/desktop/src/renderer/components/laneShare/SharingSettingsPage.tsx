import React from "react";
import { ArrowSquareOut, ArrowsClockwise, DotsThree, GitBranch, PencilSimple, Robot, SignOut, UserMinus, UsersThree, Tray } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import {
  laneSharePresetRights,
  type LaneSharePresetName,
} from "../../../shared/laneShareRights";
import type { LaneShareGivenEntry, LaneShareReceivedEntry } from "../../../shared/types/laneShare";
import type { OpenProjectBinding } from "../../../shared/types";
import { LANE_SHARING_UNAVAILABLE } from "../../../shared/laneShareDirectory";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import { useActiveRepositoryReader } from "../../state/repositoryScope";
import { ModernPage, ModernRows, ModernSection } from "../settings/primitives";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "../ui/ContextMenu";
import { Banner } from "../ui/notice";
import { confirmDialog } from "../ui/dialog";
import { showToast } from "../app/toast/toastStore";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { LaneSharePresetPicker, LaneShareRightsPanel, LaneShareRiskSummary } from "./LaneShareRightsPanel";
import { LaneShareRiskWord, LaneShareState } from "./laneShareUi";
import { revokeGivenShares, revokeLaneShares } from "./laneShareActions";
import { useLaneShareDefaults, writeLaneShareDefaults, type LaneShareDefaults } from "./laneShareDefaults";
import {
  formatLaneShareEnd,
  laneShareAccessText,
  isLiveLaneShare,
  laneSharePresetText,
  laneShareGrantStateLabel,
  laneShareInviteExpired,
  laneShareProblem,
  laneShareRightsPreset,
  laneShareStateLabel,
  laneShareUsageText,
  sameLaneShareRights,
  type LaneShareProblem,
} from "./laneShareModel";
import { laneShareListKey, openLaneShareSheet, useLaneShareStore } from "./laneShareStore";
import {
  acceptLaneShare,
  laneShareGuestProblem,
  leaveLaneShare,
  loadLaneShareReceived,
  useLaneShareGuestLaneName,
  useLaneShareGuestStore,
} from "./guest/laneShareGuestStore";
import { laneShareGuestPath } from "./guest/laneShareGuestRoute";
import "./sharingSettings.css";

/**
 * Settings › Sharing (account level), three sections on one page:
 *
 * - "Lanes you shared": every share the account gave, on any machine, grouped
 *   by project, one row per person. Rows of the machine and project this
 *   window is bound to carry rights and usage and can be changed; a share on
 *   another computer can be stopped from here (the directory records it at
 *   once; that computer drops the guest at its next grant read).
 * - "Lanes shared with you": the shares given to this account (an account
 *   call, no project needed), with Accept, Open and Leave.
 * - "Default access": where the share sheet starts for a new person.
 *
 * Every lane call goes to the open repository's reader copy (the tab's copy
 * while it has one): these lists are the account's, and that runtime asks the
 * account directory. With no copy online, nothing is sent to a machine.
 */

type ListState<T> = { status: "loading" | "ready" | "error"; data: T | null; problem: LaneShareProblem | null };

function projectTitle(entry: { projectLabel: string | null; repoKey: string | null }): string {
  if (entry.projectLabel) return entry.projectLabel;
  const repo = entry.repoKey?.replace(/^repo:/, "") ?? "";
  return repo.split("/").slice(-1)[0] || "Project";
}

function groupBy<T extends { repoKey: string | null; projectLabel: string | null }>(rows: readonly T[]): Array<{ key: string; title: string; rows: T[] }> {
  const groups = new Map<string, { key: string; title: string; rows: T[] }>();
  for (const row of rows) {
    const key = row.repoKey ?? row.projectLabel ?? "unknown";
    const group = groups.get(key) ?? { key, title: projectTitle(row), rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function countText(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** One person can hold shares of several lanes: count each email once. */
function peopleCount(rows: readonly LaneShareGivenEntry[]): number {
  return new Set(rows.map((row) => row.receiverEmail ?? row.grantId)).size;
}

function useBoundRuntimeReady(): { boundKey: string | null; active: boolean; pin: OpenProjectBinding | null } {
  const boundKey = useAppStore((s) => s.projectBinding?.key ?? null);
  const activeKey = useRootAppStore((s) => s.projectBinding?.key ?? null);
  const tabActive = Boolean(boundKey) && boundKey === activeKey;
  const pin = useActiveRepositoryReader(tabActive);
  return { boundKey, active: tabActive && pin != null, pin };
}

/** A project's name and how many rows it holds, with an optional action on the right. */
function GroupHead({ title, count, action }: { title: string; count: string; action?: React.ReactNode }) {
  return (
    <div className="ade-shr-group-head">
      <span className="ade-shr-group-name" title={title}>{title}</span>
      <span className="ade-shr-group-count kit-num">{count}</span>
      {action ? <span className="ade-shr-group-action">{action}</span> : null}
    </div>
  );
}

/** An empty list: a glyph, what is missing, and how to change it. */
function EmptyList({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <ModernRows>
      <div className="ade-shr-empty">
        <span className="ade-modern-glyph" aria-hidden>{icon}</span>
        <div className="ade-ap-rowtitle">{title}</div>
        <div className="ade-ap-rowhint">{hint}</div>
      </div>
    </ModernRows>
  );
}

function LanesYouShared() {
  const { boundKey, active, pin } = useBoundRuntimeReady();
  const pinKey = pin?.key ?? null;
  const pinRef = React.useRef(pin);
  pinRef.current = pin;
  const revokePending = useLaneShareStore((s) => s.revokePending);
  const [state, setState] = React.useState<ListState<LaneShareGivenEntry[]>>({ status: "loading", data: null, problem: null });
  const [menu, setMenu] = React.useState<{ point: ContextMenuState; entry: LaneShareGivenEntry } | null>(null);
  const [busyGroup, setBusyGroup] = React.useState<string | null>(null);

  // The list is the account's: read straight from the account directory, so
  // it shows with every computer off. A copy of the open project that is
  // online adds what only the lane's computer knows (rights, usage,
  // connections) to its own rows.
  // Each read takes a number; an answer that a newer read (or an unmount) replaced is dropped.
  const loadSeq = React.useRef(0);
  const load = React.useCallback(async () => {
    const seq = ++loadSeq.current;
    const listPin = active ? pinRef.current : null;
    const [account, runtime] = await Promise.allSettled([
      window.ade.laneShareGuest.listGiven(),
      listPin ? window.ade.laneShare.list({ scope: "account" }, listPin) : Promise.resolve(null),
    ]);
    if (seq !== loadSeq.current) return;
    if (account.status === "rejected" && (runtime.status === "rejected" || runtime.value == null)) {
      setState((current) => ({ status: "error", data: current.data, problem: laneShareProblem(account.reason) }));
      return;
    }
    if (runtime.status === "rejected") {
      // The rows still show from the account, without rights, usage or connections.
      logRendererDebugEvent("lane_share.by_me_runtime_list_failed", { error: runtime.reason instanceof Error ? runtime.reason.message : String(runtime.reason) });
    }
    const enriched = runtime.status === "fulfilled" && runtime.value ? runtime.value.shares ?? [] : [];
    const byId = new Map<string, LaneShareGivenEntry>();
    for (const entry of account.status === "fulfilled" ? account.value : []) byId.set(entry.grantId, entry);
    for (const entry of enriched) if (entry.local || !byId.has(entry.grantId)) byId.set(entry.grantId, entry);
    setState({ status: "ready", data: [...byId.values()], problem: null });
    // `pinKey` carries the pin's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pinKey]);

  React.useEffect(() => {
    void load();
    const subscribedPin = active ? pinRef.current : null;
    // A read still out when this effect ends is not this effect's answer.
    if (!subscribedPin) return () => { loadSeq.current += 1; };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.ade.laneShare.onEvent((event) => {
      if (event.type === "lane_share_guest_turn_running") return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 400);
    }, subscribedPin);
    return () => {
      loadSeq.current += 1;
      off();
      if (timer) clearTimeout(timer);
    };
  }, [active, boundKey, load]);

  const rows = (state.data ?? []).filter((entry) => isLiveLaneShare(entry) || entry.state === "expired");
  const groups = groupBy(rows);
  const listKey = laneShareListKey(pin, boundKey);

  const edit = (entry: LaneShareGivenEntry) => {
    openLaneShareSheet({
      listKey,
      laneId: entry.laneId,
      laneName: entry.laneLabel ?? "Lane",
      pin,
      machineName: null,
      grantId: entry.grantId,
    });
  };

  const resend = async (entry: LaneShareGivenEntry) => {
    if (!pin) return;
    try {
      await window.ade.laneShare.resendInvite({ grantId: entry.grantId }, pin);
      showToast({ tone: "success", title: "Invite sent again", message: "It works for 24 hours." });
      await load();
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't send the invite again", message: laneShareProblem(error).message });
    }
  };

  const revoke = async (
    entries: LaneShareGivenEntry[],
    dialog: { title: string; message: string; confirmLabel: string },
    groupKey: string | null,
  ) => {
    const ok = await confirmDialog({ ...dialog, destructive: true, size: "md" });
    if (!ok) return;
    setBusyGroup(groupKey);
    try {
      // A share of the copy that answered stops on its computer, which drops
      // the guest at once; any other stops at the account (`revokeGivenShares`).
      const here = pin ? entries.filter((entry) => entry.local) : [];
      const elsewhere = entries.filter((entry) => !here.includes(entry));
      if (here.length > 0) await revokeLaneShares(here, pin, listKey);
      if (elsewhere.length > 0) await revokeGivenShares(elsewhere);
      await load();
    } finally {
      setBusyGroup(null);
    }
  };

  const menuEntries = (entry: LaneShareGivenEntry): ContextMenuEntry[] => {
    const live = isLiveLaneShare(entry);
    const pending = revokePending[entry.grantId] === true;
    const who = entry.receiverEmail ?? "this person";
    return [
      {
        kind: "item",
        key: "edit",
        label: "Change access…",
        icon: PencilSimple,
        disabled: !entry.local || !live || pending,
        ...(entry.local ? {} : { title: "You can change this from the lane's menu while its computer is online." }),
        onSelect: () => edit(entry),
      },
      {
        kind: "item",
        key: "resend",
        label: "Re-send invite",
        icon: ArrowsClockwise,
        disabled: !entry.local || entry.state !== "pending" || pending,
        onSelect: () => { void resend(entry); },
      },
      {
        kind: "item",
        key: "revoke",
        label: pending ? "Retry removing access" : "Remove access",
        icon: UserMinus,
        danger: true,
        disabled: !live && !pending,
        onSelect: () => {
          void revoke([entry], {
            title: `Remove ${who}?`,
            message: "They lose access to this lane now. A turn they started keeps running.",
            confirmLabel: "Remove access",
          }, null);
        },
      },
    ];
  };

  let body: React.ReactNode = null;
  if (state.status === "loading") {
    body = <p className="ade-modern-muted">Loading…</p>;
  } else if (groups.length === 0 && state.status === "ready") {
    body = (
      <EmptyList
        icon={<UsersThree size={16} weight="duotone" />}
        title="You haven't shared a lane"
        hint="Right-click a lane and choose Share lane."
      />
    );
  } else if (groups.length > 0) {
    body = (
      <div className="ade-shr-groups">
        {groups.map((group) => {
          const live = group.rows.filter((row) => isLiveLaneShare(row) && revokePending[row.grantId] !== true);
          const people = peopleCount(group.rows);
          return (
            <div key={group.key} className="ade-shr-group">
              <GroupHead
                title={group.title}
                count={countText(people, "person", "people")}
                action={(
                  <button
                    type="button"
                    className="ade-modern-btn"
                    data-variant="ghost"
                    data-size="sm"
                    disabled={live.length === 0 || busyGroup != null}
                    onClick={() => {
                      void revoke(live, {
                        title: `Stop sharing every lane in ${group.title}?`,
                        message: `${countText(peopleCount(live), "person loses", "people lose")} access now. Turns they started keep running.`,
                        confirmLabel: "Stop sharing",
                      }, group.key);
                    }}
                  >
                    Stop sharing all
                  </button>
                )}
              />
              <ModernRows>
                {group.rows.map((entry) => (
                  <SharedByMeRow
                    key={entry.grantId}
                    entry={entry}
                    revokePending={revokePending[entry.grantId] === true}
                    onMenu={(point) => setMenu({ point, entry })}
                  />
                ))}
              </ModernRows>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <ModernSection
      group="Sharing"
      anchor="sharing-by-me"
      title="Lanes you shared"
      hint="People with access to your lanes, on all your computers."
    >
      <div className="ade-modern-stack" data-testid="sharing-by-me">
        {state.problem ? (
          <Banner layout="inline" model={{ id: "sharing-by-me-problem", tone: state.problem.blocking ? "warning" : "error", title: state.problem.message, report: false, actions: [{ label: "Try again", onClick: () => { void load(); } }] }} />
        ) : null}
        {body}
      </div>
      {menu ? (
        <ContextMenu
          menu={menu.point}
          entries={menuEntries(menu.entry)}
          onClose={() => setMenu(null)}
          label="Share actions"
          portal
        />
      ) : null}
    </ModernSection>
  );
}

/** One person you shared a lane with: who, which lane, how much, and how it stands now. */
function SharedByMeRow({ entry, revokePending, onMenu }: {
  entry: LaneShareGivenEntry;
  revokePending: boolean;
  onMenu: (point: ContextMenuState) => void;
}) {
  const state = revokePending
    ? { label: "Removed here", tone: "warn" as const, title: "Removed on this computer. The account directory has not confirmed it yet; retry from the menu." }
    : { ...laneShareStateLabel(entry), title: undefined };
  const risk = entry.risk?.level ?? entry.directoryRisk;
  const usage = laneShareUsageText(entry);
  const who = entry.receiverEmail ?? "Guest";
  return (
    <div className="ade-shr-row" data-list="by-me">
      <div className="ade-shr-cell ade-shr-main">
        <span className="ade-shr-title" title={entry.receiverEmail ?? undefined}>{who}</span>
        {entry.createdBy === "agent" ? (
          <span className="ade-shr-sub" data-testid="lane-share-made-by-agent">
            <Robot size={11} aria-hidden />
            Made by an agent
          </span>
        ) : null}
      </div>
      <div className="ade-shr-cell ade-shr-lane">
        <span className="ade-shr-text" title={entry.laneLabel ?? undefined}>
          <GitBranch size={12} aria-hidden />
          <span>{entry.laneLabel ?? "Lane"}</span>
        </span>
      </div>
      <div className="ade-shr-cell ade-shr-access">
        <span className="ade-shr-text">
          <span>{laneShareAccessText(entry)}</span>
          {risk === "medium" || risk === "high" ? <LaneShareRiskWord level={risk} /> : null}
        </span>
        {entry.endsAt != null ? <span className="ade-shr-sub">{formatLaneShareEnd(entry.endsAt)}</span> : null}
      </div>
      <div className="ade-shr-cell ade-shr-state">
        <LaneShareState label={state.label} tone={state.tone ?? (entry.connectedDevices > 0 ? "ok" : null)} title={state.title} />
        {usage ? <span className="ade-shr-sub kit-num">{usage}</span> : null}
      </div>
      <div className="ade-shr-end">
        <button
          type="button"
          className="ade-modern-btn"
          data-variant="ghost"
          data-icon="true"
          aria-label={`Actions for ${who}`}
          title="Actions"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <DotsThree size={16} weight="bold" />
        </button>
      </div>
    </div>
  );
}

function LanesSharedWithYou() {
  // Account level: the guest calls go from this device to the account
  // directory (no project and no machine needed). Opening a lane connects
  // to the owner's computer with a one-use ticket (`/shared`).
  const received = useLaneShareGuestStore((s) => s.received);
  const status = useLaneShareGuestStore((s) => s.receivedStatus);
  const problem = useLaneShareGuestStore((s) => s.receivedProblem);
  const pendingInvitesUnavailable = useLaneShareGuestStore((s) => s.pendingInvitesUnavailable);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    void loadLaneShareReceived({ force: true });
  }, []);

  const accept = async (entry: LaneShareReceivedEntry) => {
    setBusy(entry.grantId);
    try {
      await acceptLaneShare(entry.grantId);
      showToast({ tone: "success", title: "Invite accepted" });
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't accept the invite", message: laneShareGuestProblem(error).message });
    } finally {
      setBusy(null);
    }
  };

  const leave = async (entry: LaneShareReceivedEntry) => {
    const declining = entry.state === "pending";
    const ok = await confirmDialog({
      title: declining ? "Decline this invite?" : "Leave this lane?",
      message: declining ? "The invite closes." : "You lose access to this lane. The owner can invite you again.",
      confirmLabel: declining ? "Decline" : "Leave",
      destructive: true,
    });
    if (!ok) return;
    try {
      await leaveLaneShare(entry.grantId);
      showToast({ tone: "success", title: declining ? "Invite declined" : "You left the lane" });
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't leave the lane", message: laneShareGuestProblem(error).message });
    }
  };

  const rows = (received ?? []).filter((entry) => entry.state === "pending" || entry.state === "active" || entry.state === "expired");
  const groups = groupBy(rows);

  let body: React.ReactNode = null;
  if (status === "loading" && rows.length === 0) {
    body = <p className="ade-modern-muted">Loading…</p>;
  } else if (status === "ready" && rows.length === 0) {
    body = (
      <EmptyList
        icon={<Tray size={16} weight="duotone" />}
        title="No lanes shared with you yet"
        hint="When someone shares a lane with you, it shows up here."
      />
    );
  } else if (groups.length > 0) {
    body = (
      <div className="ade-shr-groups">
        {groups.map((group) => (
          <div key={group.key} className="ade-shr-group">
            <GroupHead title={group.title} count={countText(group.rows.length, "lane", "lanes")} />
            <ModernRows>
              {group.rows.map((entry) => (
                <SharedWithMeRow
                  key={entry.grantId}
                  entry={entry}
                  busy={busy === entry.grantId}
                  onAccept={() => { void accept(entry); }}
                  onLeave={() => { void leave(entry); }}
                />
              ))}
            </ModernRows>
          </div>
        ))}
      </div>
    );
  }

  return (
    <ModernSection
      group="Sharing"
      anchor="sharing-with-me"
      title="Lanes shared with you"
      hint="Lanes other people shared with you. Open one to work in it."
    >
      <div className="ade-modern-stack" data-testid="sharing-with-me">
        {problem ? (
          <Banner
            layout="inline"
            model={{
              id: "sharing-with-me-problem",
              tone: problem.code === "signed_out" || problem.code === "no_directory" || problem.code === LANE_SHARING_UNAVAILABLE ? "info" : "warning",
              title: problem.message,
              report: false,
              actions: [{ label: "Try again", onClick: () => { void loadLaneShareReceived({ force: true, retry: true }); } }],
            }}
          />
        ) : null}
        {pendingInvitesUnavailable ? (
          <p className="ade-modern-muted">Invites can't be loaded right now. Lanes you already accepted still show.</p>
        ) : null}
        {body}
      </div>
    </ModernSection>
  );
}

/** One lane someone shared with you: the lane and who shared it, how much, its state, and what you can do. */
function SharedWithMeRow({ entry, busy, onAccept, onLeave }: {
  entry: LaneShareReceivedEntry;
  busy: boolean;
  onAccept: () => void;
  onLeave: () => void;
}) {
  const navigate = useNavigate();
  const laneName = useLaneShareGuestLaneName(entry) ?? "Lane";
  const connection = useLaneShareGuestStore((s) => s.connections[entry.grantId]);
  const offline = connection?.kind === "host_offline";
  const paused = connection?.kind === "stopped" && connection.reason === "paused";
  const state = offline ? { label: "Owner offline", tone: "warn" as const }
    : paused ? { label: "Paused", tone: "warn" as const }
      : laneShareGrantStateLabel(entry);
  const expired = laneShareInviteExpired(entry);
  return (
    <div className="ade-shr-row" data-list="with-me">
      <div className="ade-shr-cell ade-shr-main">
        <span className="ade-shr-title" title={laneName}>{laneName}</span>
        <span className="ade-shr-sub">From {entry.giverLabel ?? "another account"}</span>
      </div>
      <div className="ade-shr-cell ade-shr-access">
        <span className="ade-shr-text">
          <span>{laneSharePresetText(entry.preset)}</span>
          {entry.risk === "medium" || entry.risk === "high" ? <LaneShareRiskWord level={entry.risk} /> : null}
        </span>
        {entry.endsAt != null ? <span className="ade-shr-sub">{formatLaneShareEnd(entry.endsAt)}</span> : null}
      </div>
      <div className="ade-shr-cell ade-shr-state">
        <LaneShareState label={state.label} tone={state.tone ?? null} />
      </div>
      <div className="ade-shr-end">
        {entry.state === "pending" && !expired ? (
          <button type="button" className="ade-modern-btn" data-tone="primary" data-size="sm" disabled={busy} onClick={onAccept}>
            Accept
          </button>
        ) : null}
        {entry.state === "active" ? (
          <button type="button" className="ade-modern-btn" data-tone="primary" data-size="sm" onClick={() => navigate(laneShareGuestPath(entry.grantId))}>
            <ArrowSquareOut size={12} aria-hidden />
            Open
          </button>
        ) : null}
        {entry.state !== "expired" ? (
          <button type="button" className="ade-modern-btn" data-size="sm" onClick={onLeave}>
            {entry.state === "pending" ? null : <SignOut size={12} aria-hidden />}
            {entry.state === "pending" ? "Decline" : "Leave"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DefaultAccess() {
  const { defaults, loaded, reload } = useLaneShareDefaults();
  const [draft, setDraft] = React.useState<LaneShareDefaults | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [note, setNote] = React.useState<{ text: string; failed: boolean } | null>(null);
  React.useEffect(() => {
    if (loaded) setDraft(defaults);
  }, [defaults, loaded]);
  const dirty = draft != null && (!sameLaneShareRights(draft.rights, defaults.rights) || draft.preset !== defaults.preset);
  const change = (next: LaneShareDefaults) => {
    setDraft(next);
    setNote(null);
  };
  const pickPreset = (preset: LaneSharePresetName) => change({ preset, rights: laneSharePresetRights(preset) });

  return (
    <ModernSection
      group="Sharing"
      anchor="sharing-defaults"
      title="Default access"
      hint="Where each new share starts. Saved to your account, so every computer starts the same."
    >
      {!draft ? <p className="ade-modern-muted">Loading…</p> : (
        <div className="ade-shr-defaults" data-testid="sharing-defaults">
          <LaneSharePresetPicker value={draft.preset} label="Default access" onChange={pickPreset} />
          <LaneShareRiskSummary rights={draft.rights} />
          <LaneShareRightsPanel
            rights={draft.rights}
            endsAt={null}
            now={Date.now()}
            showEnd={false}
            onChange={(rights) => change({ preset: laneShareRightsPreset(rights), rights })}
            // A default carries no end: each share picks its own.
            onEndsAtChange={() => {}}
          />
          <div className="ade-shr-save">
            <button
              type="button"
              className="ade-modern-btn"
              data-tone="primary"
              disabled={!dirty || saving}
              onClick={() => {
                setSaving(true);
                setNote(null);
                void writeLaneShareDefaults(draft).then((error) => {
                  setSaving(false);
                  setNote(error ? { text: error, failed: true } : { text: "Saved", failed: false });
                  if (!error) reload();
                });
              }}
            >
              {saving ? "Saving…" : "Save default access"}
            </button>
            {note ? (
              <span className="ade-shr-save-note" data-tone={note.failed ? "crit" : undefined} role="status">{note.text}</span>
            ) : null}
          </div>
        </div>
      )}
    </ModernSection>
  );
}

export function SharingSettingsPage() {
  // Each section carries its own anchor, so search and links (`#sharing-with-me`) land on it.
  return (
    <ModernPage>
      <LanesYouShared />
      <LanesSharedWithYou />
      <DefaultAccess />
    </ModernPage>
  );
}
