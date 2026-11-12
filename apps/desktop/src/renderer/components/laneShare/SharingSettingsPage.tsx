import React from "react";
import { ArrowSquareOut, ArrowsClockwise, DotsThree, PencilSimple, SignOut, UserMinus } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import {
  LANE_SHARE_PRESET_NAMES,
  laneSharePresetLabel,
  laneSharePresetRights,
  type LaneSharePresetName,
} from "../../../shared/laneShareRights";
import type { LaneShareGivenEntry, LaneShareReceivedEntry } from "../../../shared/types/laneShare";
import type { OpenProjectBinding } from "../../../shared/types";
import { LANE_SHARING_UNAVAILABLE } from "../../../shared/laneShareDirectory";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import { useActiveRepositoryReader } from "../../state/repositoryScope";
import { ModernPage, ModernRow, ModernRows, ModernSection } from "../settings/primitives";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "../ui/ContextMenu";
import { Banner } from "../ui/notice";
import { confirmDialog } from "../ui/dialog";
import { showToast } from "../app/toast/toastStore";
import { LaneShareRightsPanel, LaneShareRiskSummary } from "./LaneShareRightsPanel";
import { revokeLaneShares } from "./laneShareActions";
import { useLaneShareDefaults, writeLaneShareDefaults, type LaneShareDefaults } from "./laneShareDefaults";
import {
  LANE_SHARE_PRESET_LABELS,
  LANE_SHARE_RISK_LABELS,
  formatLaneShareEnd,
  isLiveLaneShare,
  laneSharePresetText,
  laneShareGrantStateLabel,
  laneShareInviteExpired,
  laneShareProblem,
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
  useLaneShareGuestStore,
} from "./guest/laneShareGuestStore";
import { laneShareGuestPath } from "./guest/laneShareGuestRoute";

/**
 * Settings › Sharing (account level). "Shared by me": every share the account
 * gave, on any machine, grouped by project, one row per person. Rows of the
 * machine and project this window is bound to carry rights and usage and can
 * be edited; a share on another computer can be stopped from here (the
 * directory records it at once; that computer drops the guest at its next
 * grant read). "Shared with me": the shares given to this account (an
 * account call, no project needed), with Accept, Open and Leave.
 *
 * Every call goes to the open repository's reader copy (the tab's copy while
 * it has one): these lists are the account's, and that runtime asks the
 * account directory. With no copy online, nothing is sent.
 */

type ListState<T> = { status: "loading" | "ready" | "error"; data: T | null; problem: LaneShareProblem | null };

function riskTone(level: string | null | undefined): "ok" | "warn" | "crit" | undefined {
  return level === "high" ? "crit" : level === "medium" ? "warn" : level === "low" ? "ok" : undefined;
}

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

function useBoundRuntimeReady(): { boundKey: string | null; active: boolean; pin: OpenProjectBinding | null } {
  const boundKey = useAppStore((s) => s.projectBinding?.key ?? null);
  const activeKey = useRootAppStore((s) => s.projectBinding?.key ?? null);
  const tabActive = Boolean(boundKey) && boundKey === activeKey;
  const pin = useActiveRepositoryReader(tabActive);
  return { boundKey, active: tabActive && pin != null, pin };
}

function SharedByMe() {
  const { boundKey, active, pin } = useBoundRuntimeReady();
  const pinKey = pin?.key ?? null;
  const pinRef = React.useRef(pin);
  pinRef.current = pin;
  const revokePending = useLaneShareStore((s) => s.revokePending);
  const [state, setState] = React.useState<ListState<LaneShareGivenEntry[]>>({ status: "loading", data: null, problem: null });
  const [menu, setMenu] = React.useState<{ point: ContextMenuState; entry: LaneShareGivenEntry } | null>(null);
  const [busyGroup, setBusyGroup] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const listPin = pinRef.current;
    if (!active || !listPin) return;
    try {
      const result = await window.ade.laneShare.list({ scope: "account" }, listPin);
      setState({ status: "ready", data: result.shares ?? [], problem: null });
    } catch (error) {
      setState((current) => ({ status: "error", data: current.data, problem: laneShareProblem(error) }));
    }
    // `pinKey` carries the pin's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pinKey]);

  React.useEffect(() => {
    const subscribedPin = pinRef.current;
    if (!active || !subscribedPin) return;
    void load();
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

  const revoke = async (entries: LaneShareGivenEntry[], title: string, message: string, groupKey: string | null) => {
    if (!pin) return;
    const ok = await confirmDialog({ title, message, confirmLabel: "Stop sharing", destructive: true, size: "md" });
    if (!ok) return;
    setBusyGroup(groupKey);
    try {
      await revokeLaneShares(entries, pin, listKey);
      await load();
    } finally {
      setBusyGroup(null);
    }
  };

  const menuEntries = (entry: LaneShareGivenEntry): ContextMenuEntry[] => {
    const live = isLiveLaneShare(entry);
    const pending = revokePending[entry.grantId] === true;
    return [
      {
        kind: "item",
        key: "edit",
        label: "Edit rights…",
        icon: PencilSimple,
        disabled: !entry.local || !live || pending,
        ...(entry.local ? {} : { title: "Open this project on the computer that holds the lane to edit it." }),
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
        label: pending ? "Retry revoke" : "Revoke",
        icon: UserMinus,
        danger: true,
        disabled: !live && !pending,
        onSelect: () => {
          void revoke([entry], `Stop sharing with ${entry.receiverEmail ?? "this guest"}?`, "They lose access now. A turn they started keeps running.", null);
        },
      },
    ];
  };

  if (!boundKey) {
    return <div className="text-[12px] text-fg/55">Open a project to see and manage your shares.</div>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="sharing-by-me">
      {state.problem ? (
        <Banner layout="inline" model={{ id: "sharing-by-me-problem", tone: state.problem.blocking ? "warning" : "error", title: state.problem.message, report: false, actions: [{ label: "Try again", onClick: () => { void load(); } }] }} />
      ) : null}
      {state.status === "loading" ? <div className="text-[12px] text-fg/50">Loading…</div> : null}
      {state.status === "ready" && groups.length === 0 ? (
        <div className="text-[12px] text-fg/55">You are not sharing any lane. Right-click a lane and choose Share lane.</div>
      ) : null}
      {groups.map((group) => {
        const live = group.rows.filter((row) => isLiveLaneShare(row) && revokePending[row.grantId] !== true);
        return (
          <section key={group.key} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg/85" title={group.title}>{group.title}</span>
              <button
                type="button"
                className="kit-btn"
                data-size="sm"
                data-tone="crit"
                disabled={live.length === 0 || busyGroup != null}
                onClick={() => {
                  void revoke(live, `Stop all shares in ${group.title}?`, `${live.length === 1 ? "1 person loses" : `${live.length} people lose`} access now. Turns they started keep running.`, group.key);
                }}
              >
                Stop all
              </button>
            </div>
            <ModernRows>
              {group.rows.map((entry) => {
                const pendingRevoke = revokePending[entry.grantId] === true;
                const state = pendingRevoke ? { label: "Removed here, the directory will follow", tone: "warn" as const } : laneShareStateLabel(entry);
                const preset = entry.rights ? LANE_SHARE_PRESET_LABELS[laneSharePresetLabel(entry.rights)] : laneSharePresetText(entry.preset);
                const risk = entry.risk?.level ?? entry.directoryRisk;
                const usage = laneShareUsageText(entry);
                return (
                  <ModernRow
                    key={entry.grantId}
                    title={<span className="block min-w-0 truncate" title={entry.receiverEmail ?? undefined}>{entry.receiverEmail ?? "Guest"}</span>}
                    hint={
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="min-w-0 truncate" title={entry.laneLabel ?? undefined}>{entry.laneLabel ?? "Lane"}</span>
                        <span>{preset}</span>
                        {risk ? <span className="kit-tag" data-tone={riskTone(risk)}>{LANE_SHARE_RISK_LABELS[risk]}</span> : null}
                        {usage ? <span className="kit-num">{usage}</span> : null}
                        <span>{formatLaneShareEnd(entry.endsAt)}</span>
                        <span className="kit-tag" data-tone={state.tone ?? undefined}>{state.label}</span>
                        {entry.createdBy === "agent" ? <span data-testid="lane-share-made-by-agent">Made by an agent</span> : null}
                        {!entry.local ? <span className="text-fg/40">On another computer</span> : null}
                      </span>
                    }
                    control={
                      <button
                        type="button"
                        className="kit-icon-btn"
                        aria-label={`Actions for ${entry.receiverEmail ?? "this guest"}`}
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setMenu({ point: { x: rect.left, y: rect.bottom + 4 }, entry });
                        }}
                      >
                        <DotsThree size={16} weight="bold" />
                      </button>
                    }
                  />
                );
              })}
            </ModernRows>
          </section>
        );
      })}
      {menu ? (
        <ContextMenu
          menu={menu.point}
          entries={menuEntries(menu.entry)}
          onClose={() => setMenu(null)}
          label="Share actions"
          portal
        />
      ) : null}
    </div>
  );
}

function SharedWithMe() {
  // Account level: the guest calls go from this device to the account
  // directory (no project and no machine needed). Opening a lane connects
  // to the owner's computer with a one-use ticket (`/shared`).
  const navigate = useNavigate();
  const received = useLaneShareGuestStore((s) => s.received);
  const status = useLaneShareGuestStore((s) => s.receivedStatus);
  const problem = useLaneShareGuestStore((s) => s.receivedProblem);
  const pendingInvitesUnavailable = useLaneShareGuestStore((s) => s.pendingInvitesUnavailable);
  const connections = useLaneShareGuestStore((s) => s.connections);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    void loadLaneShareReceived({ force: true });
  }, []);

  const accept = async (entry: LaneShareReceivedEntry) => {
    setBusy(entry.grantId);
    try {
      await acceptLaneShare(entry.grantId);
      showToast({ tone: "success", title: "Lane added to Shared with me" });
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

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="sharing-with-me">
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
        <div className="text-[11.5px] text-fg/55">Pending invites can't be read right now. Lanes you accepted are listed.</div>
      ) : null}
      {status === "loading" ? <div className="text-[12px] text-fg/50">Loading…</div> : null}
      {status === "ready" && rows.length === 0 ? <div className="text-[12px] text-fg/55">Nobody shares a lane with you.</div> : null}
      {groups.map((group) => (
        <section key={group.key} className="flex min-w-0 flex-col gap-1.5">
          <span className="min-w-0 truncate text-[12.5px] font-medium text-fg/85" title={group.title}>{group.title}</span>
          <ModernRows>
            {group.rows.map((entry) => {
              const stateLabel = laneShareGrantStateLabel(entry);
              const connection = connections[entry.grantId];
              const expired = laneShareInviteExpired(entry);
              return (
                <ModernRow
                  key={entry.grantId}
                  title={<span className="block min-w-0 truncate" title={entry.laneLabel ?? undefined}>{entry.laneLabel ?? "Lane"}</span>}
                  hint={
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="min-w-0 truncate">From {entry.giverLabel ?? "another account"}</span>
                      <span>{laneSharePresetText(entry.preset)}</span>
                      {entry.risk ? <span className="kit-tag" data-tone={riskTone(entry.risk)}>{LANE_SHARE_RISK_LABELS[entry.risk]}</span> : null}
                      <span>{formatLaneShareEnd(entry.endsAt)}</span>
                      <span className="kit-tag" data-tone={stateLabel.tone ?? undefined}>{stateLabel.label}</span>
                      {connection?.kind === "host_offline" ? <span className="kit-tag" data-tone="warn">Owner offline</span> : null}
                      {connection?.kind === "stopped" && connection.reason === "paused" ? <span className="kit-tag" data-tone="warn">Paused</span> : null}
                    </span>
                  }
                  control={
                    <span className="flex items-center gap-1.5">
                      {entry.state === "pending" && !expired ? (
                        <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={busy === entry.grantId} onClick={() => { void accept(entry); }}>
                          Accept
                        </button>
                      ) : null}
                      {entry.state === "active" ? (
                        <button type="button" className="kit-btn kit-btn-primary" data-size="sm" onClick={() => navigate(laneShareGuestPath(entry.grantId))}>
                          <ArrowSquareOut size={13} />
                          Open
                        </button>
                      ) : null}
                      {entry.state !== "expired" ? (
                        <button type="button" className="kit-btn" data-size="sm" onClick={() => { void leave(entry); }}>
                          <SignOut size={13} />
                          {entry.state === "pending" ? "Decline" : "Leave"}
                        </button>
                      ) : null}
                    </span>
                  }
                />
              );
            })}
          </ModernRows>
        </section>
      ))}
    </div>
  );
}

function DefaultRights() {
  const { defaults, loaded, reload } = useLaneShareDefaults();
  const [draft, setDraft] = React.useState<LaneShareDefaults | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (loaded) setDraft(defaults);
  }, [defaults, loaded]);
  if (!draft) return <div className="text-[12px] text-fg/50">Loading…</div>;
  const dirty = !sameLaneShareRights(draft.rights, defaults.rights) || draft.preset !== defaults.preset;
  const pickPreset = (preset: LaneSharePresetName) => setDraft({ preset, rights: laneSharePresetRights(preset) });
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="sharing-defaults">
      <div className="kit-seg" data-case="sentence" role="radiogroup" aria-label="Default preset">
        {LANE_SHARE_PRESET_NAMES.map((preset) => (
          <button key={preset} type="button" role="radio" aria-checked={draft.preset === preset} onClick={() => pickPreset(preset)}>
            {LANE_SHARE_PRESET_LABELS[preset]}
          </button>
        ))}
      </div>
      <LaneShareRiskSummary rights={draft.rights} />
      <div className="kit-panel p-3">
        <LaneShareRightsPanel
          rights={draft.rights}
          endsAt={null}
          now={Date.now()}
          onChange={(rights) => {
            const label = laneSharePresetLabel(rights);
            setDraft({ preset: sameLaneShareRights(rights, laneSharePresetRights(label)) ? label : "custom", rights });
          }}
          // A default carries no end: each share picks its own.
          onEndsAtChange={() => {}}
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="kit-btn kit-btn-primary"
          disabled={!dirty || saving}
          onClick={() => {
            setSaving(true);
            setMessage(null);
            void writeLaneShareDefaults(draft).then((error) => {
              setSaving(false);
              setMessage(error ?? "Saved for your account.");
              if (!error) reload();
            });
          }}
        >
          Save default rights
        </button>
        {message ? <span className="text-[11.5px] text-fg/60" role="status">{message}</span> : null}
      </div>
    </div>
  );
}

export function SharingSettingsPage() {
  // A link to `#sharing-with-me` opens that list.
  const [tab, setTab] = React.useState<"by-me" | "with-me">(() =>
    typeof window !== "undefined" && window.location.hash.includes("sharing-with-me") ? "with-me" : "by-me");
  return (
    <ModernPage>
      {/* No heading of its own: the tab header above already says "Sharing" and what it holds. */}
      <section
        className="ade-ap-section"
        data-settings-group="Sharing"
        data-settings-anchor={tab === "by-me" ? "sharing-by-me" : "sharing-with-me"}
        id={tab === "by-me" ? "sharing-by-me" : "sharing-with-me"}
      >
        <div className="flex flex-col gap-3">
          <div className="kit-seg" data-case="sentence" role="tablist" aria-label="Sharing lists">
            <button type="button" role="tab" aria-selected={tab === "by-me"} onClick={() => setTab("by-me")}>Shared by me</button>
            <button type="button" role="tab" aria-selected={tab === "with-me"} onClick={() => setTab("with-me")}>Shared with me</button>
          </div>
          {tab === "by-me" ? <SharedByMe /> : <SharedWithMe />}
        </div>
      </section>
      <ModernSection
        group="Sharing"
        anchor="sharing-defaults"
        title="My default rights"
        hint="Where a new share starts. Saved for your account, on every computer."
      >
        <DefaultRights />
      </ModernSection>
    </ModernPage>
  );
}
