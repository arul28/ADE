import React from "react";
import { useNavigate } from "react-router-dom";
import { ShareNetwork, UserPlus } from "@phosphor-icons/react";
import {
  LANE_SHARE_PRESET_NAMES,
  laneSharePresetLabel,
  laneSharePresetRights,
  laneShareRiskLevel,
  type LaneSharePresetName,
  type LaneShareRights,
} from "../../../shared/laneShareRights";
import type { LaneShareGivenEntry } from "../../../shared/types/laneShare";
import { settingsRouteFor } from "../settings/settingsManifest";
import { Dialog, confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { showToast } from "../app/toast/toastStore";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { LaneShareRightsPanel, LaneShareRiskSummary } from "./LaneShareRightsPanel";
import { confirmHighRiskShare, useLaneShareDefaults } from "./laneShareDefaults";
import { revokeLaneShares } from "./laneShareActions";
import { LANE_SHARE_MAX_GUESTS } from "../../../shared/laneShareDirectory";
import {
  LANE_SHARE_PRESET_LABELS,
  isLiveLaneShare,
  laneShareEmailNote,
  laneSharePresetText,
  laneShareProblem,
  laneSharesForLane,
  laneShareStateLabel,
  laneShareUsageText,
  sameLaneShareRights,
} from "./laneShareModel";
import { reloadLaneShares, useLaneShareList, useLaneShareStore, type LaneShareSheetRequest } from "./laneShareStore";

/**
 * The share sheet: people on the left (invite form, one row per guest with
 * its state and preset), the selected person's rights on the right, risk
 * level and reasons live. Every call goes to the lane's own machine
 * (`request.pin`; null is the tab's machine).
 */

const NEW = "__new__";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Draft = { rights: LaneShareRights; endsAt: number | null };

function presetOf(rights: LaneShareRights): LaneSharePresetName | "custom" {
  const label = laneSharePresetLabel(rights);
  return sameLaneShareRights(rights, { ...laneSharePresetRights(label), limits: { ...laneSharePresetRights(label).limits, endsAt: rights.limits.endsAt } })
    ? label
    : "custom";
}

function withPreset(rights: LaneShareRights, preset: LaneSharePresetName): LaneShareRights {
  const next = laneSharePresetRights(preset);
  // A preset changes what the person may do; privacy and the end date stay.
  return { ...next, privacy: rights.privacy, limits: { ...next.limits, endsAt: rights.limits.endsAt } };
}

function PresetSelect({
  value,
  disabled,
  onChange,
  label,
}: {
  value: LaneSharePresetName | "custom";
  disabled?: boolean;
  onChange: (preset: LaneSharePresetName) => void;
  label: string;
}) {
  return (
    <select
      className="kit-input"
      data-size="sm"
      aria-label={label}
      disabled={disabled}
      value={value}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        const next = event.target.value;
        if ((LANE_SHARE_PRESET_NAMES as readonly string[]).includes(next)) onChange(next as LaneSharePresetName);
      }}
      style={{ width: 118, flex: "none" }}
    >
      {value === "custom" ? <option value="custom">Custom</option> : null}
      {LANE_SHARE_PRESET_NAMES.map((name) => <option key={name} value={name}>{LANE_SHARE_PRESET_LABELS[name]}</option>)}
    </select>
  );
}

function GuestRow({
  entry,
  selected,
  presetValue,
  revokePending,
  disabled,
  onSelect,
  onPreset,
}: {
  entry: LaneShareGivenEntry;
  selected: boolean;
  presetValue: LaneSharePresetName | "custom";
  revokePending: boolean;
  disabled: boolean;
  onSelect: () => void;
  onPreset: (preset: LaneSharePresetName) => void;
}) {
  const state = revokePending ? { label: "Removed here", tone: "warn" as const } : laneShareStateLabel(entry);
  const editable = entry.local && isLiveLaneShare(entry) && !revokePending;
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      className={`kit-row flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${selected ? "bg-fg/[0.07]" : ""}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      data-testid="lane-share-guest-row"
      data-state={entry.state}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-fg/88" title={entry.receiverEmail ?? undefined}>{entry.receiverEmail ?? "Guest"}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-fg/50">
          {entry.connectedDevices > 0 ? <span className="kit-dot" data-state="ok" aria-hidden /> : null}
          <span className="kit-tag" data-tone={state.tone ?? undefined}>{state.label}</span>
        </div>
      </div>
      {editable ? (
        <PresetSelect value={presetValue} disabled={disabled} onChange={onPreset} label={`Rights for ${entry.receiverEmail ?? "this guest"}`} />
      ) : (
        <span className="shrink-0 text-[11px] text-fg/45">{laneSharePresetText(entry.preset)}</span>
      )}
    </div>
  );
}

export function LaneShareSheet({ request, onClose }: { request: LaneShareSheetRequest; onClose: () => void }) {
  const navigate = useNavigate();
  const { laneId, laneName, pin, machineName } = request;
  const { key, entry } = useLaneShareList(pin, { listKey: request.listKey });
  const revokePending = useLaneShareStore((s) => s.revokePending);
  const { defaults, loaded: defaultsLoaded } = useLaneShareDefaults();
  const [now, setNow] = React.useState(() => Date.now());
  const shares = React.useMemo(() => laneSharesForLane(entry?.shares ?? [], laneId), [entry?.shares, laneId]);
  const liveCount = shares.filter(isLiveLaneShare).length;
  const atLimit = liveCount >= LANE_SHARE_MAX_GUESTS;

  const [selected, setSelected] = React.useState<string>(request.grantId ?? NEW);
  const [email, setEmail] = React.useState("");
  const [newDraft, setNewDraft] = React.useState<Draft>({ rights: defaults.rights, endsAt: null });
  const newTouched = React.useRef(false);
  const [edits, setEdits] = React.useState<Record<string, Draft>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [formError, setFormErrorState] = React.useState<{ message: string; fixable: boolean } | null>(null);
  /** A check the person can fix in the form (no report); null clears it. */
  const setFormError = (message: string | null) => setFormErrorState(message ? { message, fixable: true } : null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // The saved defaults are the start value until the owner changes something.
  React.useEffect(() => {
    if (defaultsLoaded && !newTouched.current) setNewDraft({ rights: defaults.rights, endsAt: null });
  }, [defaults, defaultsLoaded]);

  // A guest that left the list (revoked elsewhere, ended) drops the selection.
  React.useEffect(() => {
    if (selected !== NEW && entry?.status === "ready" && !shares.some((share) => share.grantId === selected)) setSelected(NEW);
  }, [entry?.status, selected, shares]);

  const problem = entry?.problem ?? null;
  const blocked = problem?.blocking === true;
  const loading = !entry || (entry.status === "loading" && entry.shares.length === 0);
  const selectedEntry = selected === NEW ? null : shares.find((share) => share.grantId === selected) ?? null;
  const selectedRevokePending = selectedEntry ? revokePending[selectedEntry.grantId] === true : false;
  const laneGone = selectedEntry?.laneState === "missing";
  const selectedEditable = Boolean(selectedEntry && selectedEntry.local && isLiveLaneShare(selectedEntry) && !laneGone && !selectedRevokePending);
  const savedDraft: Draft | null = selectedEntry
    ? { rights: selectedEntry.rights ?? defaults.rights, endsAt: selectedEntry.endsAt }
    : null;
  const draft: Draft = selectedEntry ? edits[selectedEntry.grantId] ?? savedDraft! : newDraft;
  const dirty = selectedEntry
    ? Boolean(edits[selectedEntry.grantId]) && (
      !sameLaneShareRights(edits[selectedEntry.grantId]!.rights, selectedEntry.rights)
      || edits[selectedEntry.grantId]!.endsAt !== selectedEntry.endsAt
      || selectedEntry.needsRights)
    : false;
  const formDisabled = blocked || loading || busy != null;
  const rightsDisabled = formDisabled || (selectedEntry ? !selectedEditable : false);
  const who = selectedEntry?.receiverEmail ?? (email.trim() || "this person");

  const updateDraft = (next: Draft) => {
    setFormError(null);
    if (selectedEntry) {
      setEdits((current) => ({ ...current, [selectedEntry.grantId]: next }));
    } else {
      newTouched.current = true;
      setNewDraft(next);
    }
  };

  const fail = (error: unknown) => {
    const problem = laneShareProblem(error, { pin, machineName });
    // A blocking cause (signed out, sync off, an old host) is the person's to fix; the rest is reported.
    setFormErrorState({ message: problem.message, fixable: problem.blocking });
  };

  const refresh = async () => {
    setNow(Date.now());
    await reloadLaneShares(key, pin);
  };

  const sendInvite = async (copyLink: boolean) => {
    const receiverEmail = email.trim();
    if (!EMAIL_PATTERN.test(receiverEmail)) {
      setFormError("Enter the email address of the person to invite.");
      return;
    }
    if (atLimit) {
      setFormError(`A lane can have ${LANE_SHARE_MAX_GUESTS} guests. Remove one to invite another.`);
      return;
    }
    const existing = shares.find((share) => isLiveLaneShare(share) && share.receiverEmail?.toLowerCase() === receiverEmail.toLowerCase());
    if (existing) {
      setSelected(existing.grantId);
      setFormError(`${receiverEmail} already has access. Their rights are shown here.`);
      return;
    }
    const rights: LaneShareRights = { ...newDraft.rights, limits: { ...newDraft.rights.limits, endsAt: newDraft.endsAt } };
    const high = laneShareRiskLevel(rights).level === "high";
    if (high && !(await confirmHighRiskShare(receiverEmail, rights))) return;
    setBusy("invite");
    setFormError(null);
    setNotice(null);
    try {
      const result = await window.ade.laneShare.create({
        laneId,
        receiverEmail,
        rights,
        endsAt: newDraft.endsAt,
        ...(high ? { confirmHighRisk: true } : {}),
      }, pin);
      const link = result.directory?.link ?? null;
      let copied = false;
      if (copyLink && link) copied = await copyTextToClipboard(link);
      setNotice([
        result.directory?.refreshed ? `The invite to ${receiverEmail} was sent again.` : `${receiverEmail} is invited. The invite works for 24 hours.`,
        copied ? "The link is copied." : null,
        laneShareEmailNote(result.directory),
      ].filter(Boolean).join(" "));
      setEmail("");
      newTouched.current = false;
      setNewDraft({ rights: defaults.rights, endsAt: null });
      await refresh();
      setSelected(result.grantId);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!selectedEntry || !dirty) return;
    const next = draft;
    const nextRisk = laneShareRiskLevel(next.rights).level;
    const wasHigh = selectedEntry.rights ? laneShareRiskLevel(selectedEntry.rights).level === "high" : false;
    // The dialog when an edit RAISES a share to high; a share already confirmed as high keeps that confirmation.
    if (nextRisk === "high" && !wasHigh && !(await confirmHighRiskShare(who, next.rights))) return;
    setBusy("save");
    setFormError(null);
    setNotice(null);
    try {
      const result = await window.ade.laneShare.updateRights({
        grantId: selectedEntry.grantId,
        rights: next.rights,
        ...(next.endsAt !== selectedEntry.endsAt ? { endsAt: next.endsAt } : {}),
        ...(nextRisk === "high" ? { confirmHighRisk: true } : {}),
      }, pin);
      setEdits((current) => {
        const { [selectedEntry.grantId]: _saved, ...rest } = current;
        return rest;
      });
      setNotice([
        "Saved.",
        result.appliedConnections > 0 ? "They apply to the guest's open connection now." : null,
        result.directorySynced ? null : "The account directory did not take the new label yet; this computer enforces the new rights.",
      ].filter(Boolean).join(" "));
      await refresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const resend = async (target: LaneShareGivenEntry) => {
    setBusy("resend");
    setFormError(null);
    setNotice(null);
    try {
      const result = await window.ade.laneShare.resendInvite({ grantId: target.grantId }, pin);
      setNotice(laneShareEmailNote(result.directory) ?? `The invite to ${target.receiverEmail ?? "the guest"} was sent again. It works for 24 hours.`);
      await refresh();
      setSelected(result.grantId);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (target: LaneShareGivenEntry, retry = false) => {
    if (!retry) {
      const ok = await confirmDialog({
        title: `Remove ${target.receiverEmail ?? "this guest"}?`,
        message: "They lose access to this lane now. A turn they started keeps running.",
        confirmLabel: "Remove",
        destructive: true,
        size: "md",
      });
      if (!ok) return;
    }
    setBusy("remove");
    setFormError(null);
    setNotice(null);
    try {
      await revokeLaneShares([target], pin, key);
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async (target: LaneShareGivenEntry) => {
    if (!target.link) return;
    const copied = await copyTextToClipboard(target.link);
    showToast(copied
      ? { tone: "success", title: "Invite link copied" }
      : { tone: "error", title: "Couldn't copy the link", report: false });
  };

  const inviteAgain = (target: LaneShareGivenEntry) => {
    setEmail(target.receiverEmail ?? "");
    setSelected(NEW);
  };

  const blockingActions = problem?.code === "signed_out" || problem?.code === "unauthorized"
    ? [{ label: "Open Account", onClick: () => { onClose(); navigate(settingsRouteFor("account.profile")); } }]
    : problem?.code === "no_directory" || problem?.code === "sync_off"
      ? [{ label: "Open Machines", onClick: () => { onClose(); navigate("/settings?tab=machines"); } }]
      : [{ label: "Try again", onClick: () => { void refresh(); } }];

  // Footer actions: the invite form, or the selected guest.
  const actions = blocked
    ? [{ label: "Close", onClick: onClose, variant: "secondary" as const }]
    : selectedEntry
      ? [
        ...(selectedEntry.link && isLiveLaneShare(selectedEntry) ? [{ label: "Copy link", onClick: () => { void copyLink(selectedEntry); }, variant: "secondary" as const }] : []),
        ...(selectedEditable
          ? [{ label: "Save changes", onClick: () => { void save(); }, variant: "solid" as const, disabled: !dirty || busy != null, busy: busy === "save" }]
          : []),
      ]
      : [
        { label: "Copy link", onClick: () => { void sendInvite(true); }, variant: "secondary" as const, disabled: formDisabled || atLimit || !email.trim(), busy: busy === "invite" },
        { label: "Send invite", onClick: () => { void sendInvite(false); }, variant: "solid" as const, disabled: formDisabled || atLimit || !email.trim(), busy: busy === "invite" },
      ];

  const selectedState = selectedEntry ? laneShareStateLabel(selectedEntry, now) : null;
  const usage = selectedEntry ? laneShareUsageText(selectedEntry) : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={`Share ${laneName}`}
      description={machineName ? `On ${machineName}` : "Give another ADE account limited access to this lane."}
      icon={<ShareNetwork size={18} weight="duotone" />}
      size="lg"
      width={860}
      actions={actions}
      testId="lane-share-sheet"
      bodyStyle={{ paddingTop: 4 }}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {problem ? (
          <Banner
            layout="inline"
            model={{
              id: `lane-share-problem-${problem.code ?? "error"}`,
              tone: blocked ? "warning" : "error",
              title: problem.message,
              report: false,
              actions: blockingActions,
            }}
          />
        ) : null}
        <div className="grid min-w-0 gap-4" style={{ gridTemplateColumns: "minmax(0, 300px) minmax(0, 1fr)" }}>
          {/* People */}
          <div className="flex min-w-0 flex-col gap-2" data-testid="lane-share-people">
            <div
              role="option"
              aria-selected={selected === NEW}
              tabIndex={0}
              className={`kit-panel flex flex-col gap-2 p-2.5 ${selected === NEW ? "" : "cursor-pointer"}`}
              onClick={() => setSelected(NEW)}
              onKeyDown={(event) => { if (event.key === "Enter") setSelected(NEW); }}
            >
              <div className="flex items-center gap-1.5 text-[12px] text-fg/80">
                <UserPlus size={13} weight="duotone" />
                Invite a person
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <input
                  className="kit-input min-w-0 flex-1"
                  type="email"
                  placeholder="Email address"
                  aria-label="Email address to invite"
                  value={email}
                  disabled={formDisabled || atLimit}
                  onFocus={() => setSelected(NEW)}
                  onChange={(event) => {
                    setFormError(null);
                    setEmail(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void sendInvite(false);
                    }
                  }}
                />
                <PresetSelect
                  value={presetOf(newDraft.rights)}
                  disabled={formDisabled || atLimit}
                  label="Rights for the new person"
                  onChange={(preset) => {
                    setSelected(NEW);
                    newTouched.current = true;
                    setNewDraft((current) => ({ ...current, rights: withPreset(current.rights, preset) }));
                  }}
                />
              </div>
              {atLimit ? (
                <div className="text-[11px] leading-[1.4] text-fg/55">
                  A lane can have {LANE_SHARE_MAX_GUESTS} guests, pending invites included. Remove one to invite another.
                </div>
              ) : null}
            </div>

            <div role="listbox" aria-label="People with access" className="flex min-w-0 flex-col gap-0.5">
              {loading ? (
                <div className="px-2 py-1.5 text-[12px] text-fg/50">Loading…</div>
              ) : shares.length === 0 ? (
                <div className="px-2 py-1.5 text-[12px] text-fg/50">Nobody has access to this lane yet.</div>
              ) : shares.map((share) => {
                const shareDraft = edits[share.grantId]?.rights ?? share.rights;
                return (
                  <GuestRow
                    key={share.grantId}
                    entry={share}
                    selected={selected === share.grantId}
                    presetValue={shareDraft ? presetOf(shareDraft) : "custom"}
                    revokePending={revokePending[share.grantId] === true}
                    disabled={formDisabled}
                    onSelect={() => {
                      setFormError(null);
                      setSelected(share.grantId);
                    }}
                    onPreset={(preset) => {
                      setSelected(share.grantId);
                      const base = edits[share.grantId] ?? { rights: share.rights ?? defaults.rights, endsAt: share.endsAt };
                      setEdits((current) => ({ ...current, [share.grantId]: { ...base, rights: withPreset(base.rights, preset) } }));
                    }}
                  />
                );
              })}
            </div>
            <div className="px-2 text-[10.5px] text-fg/40">
              <span className="kit-num">{liveCount}</span> of {LANE_SHARE_MAX_GUESTS} guests
            </div>
          </div>

          {/* Rights of the selected person */}
          <div className="flex min-w-0 flex-col gap-2" data-testid="lane-share-rights-pane">
            {selectedEntry ? (
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-[13px] font-medium text-fg/90" title={selectedEntry.receiverEmail ?? undefined}>
                    {selectedEntry.receiverEmail ?? "Guest"}
                  </span>
                  {selectedState ? <span className="kit-tag" data-tone={selectedState.tone ?? undefined}>{selectedRevokePending ? "Removed here" : selectedState.label}</span> : null}
                  {usage ? <span className="kit-num text-[11px] text-fg/50">{usage}</span> : null}
                </div>
                {selectedRevokePending ? (
                  <Banner layout="inline" model={{
                    id: "lane-share-revoke-pending",
                    tone: "warning",
                    title: "Removed on this computer. The account directory will follow.",
                    detail: "The directory did not answer the revoke. Retry to finish it.",
                    report: false,
                    actions: [{ label: "Retry", onClick: () => { void remove(selectedEntry, true); }, busy: busy === "remove" }],
                  }} />
                ) : null}
                {selectedEntry.connectedDevices > 0 && selectedEditable ? (
                  <div className="text-[11px] text-fg/55">Connected now. A change applies to their next action.</div>
                ) : null}
                {selectedEntry.needsRights && !selectedRevokePending ? (
                  <div className="text-[11px] text-fg/55">This computer holds no rights for this share, so the guest gets nothing. Save rights here, or remove the share.</div>
                ) : null}
                {selectedEntry.laneState === "archived" ? (
                  <div className="text-[11px] text-fg/55">The lane is archived, so the share is paused. Unarchive the lane to resume it.</div>
                ) : null}
                {laneGone ? (
                  <div className="text-[11px] text-fg/55">The lane was deleted, so the share ended.</div>
                ) : null}
                {!selectedEntry.local ? (
                  <div className="text-[11px] text-fg/55">This share was made on another computer. Edit it there.</div>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  {selectedEntry.state === "pending" && selectedEntry.local && !selectedRevokePending ? (
                    <button type="button" className="kit-btn" data-size="sm" disabled={formDisabled} onClick={() => { void resend(selectedEntry); }}>
                      Re-send invite
                    </button>
                  ) : null}
                  {selectedEntry.state === "expired" ? (
                    <button type="button" className="kit-btn" data-size="sm" disabled={formDisabled || atLimit} onClick={() => inviteAgain(selectedEntry)}>
                      Invite again
                    </button>
                  ) : null}
                  {isLiveLaneShare(selectedEntry) && !selectedRevokePending ? (
                    <button type="button" className="kit-btn" data-size="sm" data-tone="crit" disabled={blocked || busy != null} onClick={() => { void remove(selectedEntry); }}>
                      Remove access
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-fg/60">Rights for the new person. They start from your default rights.</div>
            )}
            <LaneShareRiskSummary rights={draft.rights} />
            {formError ? (
              <Banner
                layout="inline"
                model={{ id: "lane-share-form-error", tone: "error", title: formError.message, ...(formError.fixable ? { report: false } : {}) }}
              />
            ) : null}
            {notice ? <div className="text-[11.5px] leading-[1.4] text-fg/70" role="status">{notice}</div> : null}
            <div className="min-h-0 overflow-y-auto pr-1" style={{ maxHeight: "48vh" }}>
              <LaneShareRightsPanel
                rights={draft.rights}
                endsAt={draft.endsAt}
                now={now}
                disabled={rightsDisabled}
                onChange={(rights) => updateDraft({ ...draft, rights })}
                onEndsAtChange={(endsAt) => updateDraft({ ...draft, endsAt })}
              />
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
