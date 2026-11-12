import React from "react";
import { useNavigate } from "react-router-dom";
import { ShareNetwork, UserCircle } from "@phosphor-icons/react";
import {
  laneSharePresetRights,
  laneShareRightsForHost,
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
import { LaneSharePresetPicker, LaneShareRightsPanel, LaneShareRiskSummary, laneShareRightsPreset } from "./LaneShareRightsPanel";
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
  return laneShareRightsPreset(rights);
}

function withPreset(rights: LaneShareRights, preset: LaneSharePresetName): LaneShareRights {
  const next = laneSharePresetRights(preset);
  // A preset changes what the person may do; privacy and the end date stay.
  return { ...next, privacy: rights.privacy, limits: { ...next.limits, endsAt: rights.limits.endsAt } };
}

/** One person with access: their address, then state, access level and who made it, on one quiet line. */
function PersonRow({
  entry,
  selected,
  presetValue,
  revokePending,
  onSelect,
}: {
  entry: LaneShareGivenEntry;
  selected: boolean;
  presetValue: LaneSharePresetName | "custom";
  revokePending: boolean;
  onSelect: () => void;
}) {
  const state = revokePending ? { label: "Removed here", tone: "warn" as const } : laneShareStateLabel(entry);
  const access = presetValue === "custom" ? laneSharePresetText(entry.preset) : LANE_SHARE_PRESET_LABELS[presetValue];
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      className="ade-ls-person"
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
      <UserCircle size={18} className="ade-ls-person-glyph" aria-hidden />
      <div className="ade-ls-person-text">
        <div className="ade-ls-person-name" title={entry.receiverEmail ?? undefined}>{entry.receiverEmail ?? "Guest"}</div>
        <div className="ade-ls-person-meta">
          {entry.connectedDevices > 0 ? <span className="kit-dot" data-state="ok" aria-hidden /> : null}
          <span data-tone={state.tone ?? undefined}>{state.label}</span>
          <span aria-hidden>·</span>
          <span>{access}</span>
          {entry.createdBy === "agent" ? (
            <>
              <span aria-hidden>·</span>
              <span data-testid="lane-share-made-by-agent">Made by an agent</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One plain line about the selected share's state, when it needs saying. */
function SelectedNote({ entry, editable, laneGone, revokePending }: { entry: LaneShareGivenEntry; editable: boolean; laneGone: boolean; revokePending: boolean }) {
  const line = revokePending
    ? null
    : laneGone
      ? "The lane was deleted, so the share ended."
      : !entry.local
        ? "This share was made on another computer. Change it there."
        : entry.needsRights
          ? "This computer holds no rights for this share, so they get nothing. Save rights here, or remove the share."
          : entry.laneState === "archived"
            ? "The lane is archived, so the share is paused. Unarchive the lane to resume it."
            : entry.connectedDevices > 0 && editable
              ? "Connected now. A change applies to their next action."
              : null;
  return line ? <div className="ade-ls-line">{line}</div> : null;
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

  // The lane's machine decides whether a guest may type into a CLI there:
  // where it cannot, every draft holds the switch off, so the risk, the
  // preset and the rights sent match what that machine enforces.
  const cliTyping = entry?.cliTyping ?? null;
  const forHost = (rights: LaneShareRights): LaneShareRights => laneShareRightsForHost(rights, cliTyping);
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
  const shownDraft: Draft = selectedEntry ? edits[selectedEntry.grantId] ?? savedDraft! : newDraft;
  const draft: Draft = { ...shownDraft, rights: forHost(shownDraft.rights) };
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
    const rights: LaneShareRights = forHost({ ...newDraft.rights, limits: { ...newDraft.rights.limits, endsAt: newDraft.endsAt } });
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
        <div className="ade-ls-sheet">
          {/* People */}
          <div className="ade-ls-people" data-testid="lane-share-people">
            <h3 className="ade-ls-pane-title">
              People
              <span className="kit-num">{liveCount} of {LANE_SHARE_MAX_GUESTS}</span>
            </h3>
            <div className="ade-ls-invite">
              <input
                className="kit-input"
                type="email"
                placeholder="Invite by email"
                aria-label="Email address to invite"
                value={email}
                disabled={formDisabled || atLimit}
                onFocus={() => setSelected(NEW)}
                onChange={(event) => {
                  setFormError(null);
                  setSelected(NEW);
                  setEmail(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void sendInvite(false);
                  }
                }}
              />
            </div>
            {atLimit ? (
              <div className="ade-ls-line">A lane can have {LANE_SHARE_MAX_GUESTS} people, invites included. Remove one to invite another.</div>
            ) : null}

            <div role="listbox" aria-label="People with access" className="ade-ls-person-list">
                          {loading ? (
                <div className="ade-ls-empty">Loading…</div>
              ) : shares.length === 0 ? (
                <div className="ade-ls-empty">Nobody has access yet.</div>
              ) : shares.map((share) => {
                const shareDraft = edits[share.grantId]?.rights ?? share.rights;
                return (
                  <PersonRow
                    key={share.grantId}
                    entry={share}
                    selected={selected === share.grantId}
                    presetValue={shareDraft ? presetOf(forHost(shareDraft)) : "custom"}
                    revokePending={revokePending[share.grantId] === true}
                    onSelect={() => {
                      setFormError(null);
                      setSelected(share.grantId);
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* Access of the selected person, or of the person being invited */}
          <div className="ade-ls-access" data-testid="lane-share-rights-pane">
            <div className="ade-ls-access-head">
              <div className="ade-ls-access-who">
                <span className="ade-ls-access-name" title={selectedEntry?.receiverEmail ?? undefined}>
                  {selectedEntry ? selectedEntry.receiverEmail ?? "Guest" : email.trim() || "New person"}
                </span>
                {selectedEntry && selectedState ? (
                  <span className="ade-ls-state">
                    <span className="kit-dot" data-state={selectedState.tone === "crit" ? "crit" : selectedState.tone === "warn" ? "warn" : selectedEntry.connectedDevices > 0 ? "ok" : undefined} aria-hidden />
                    {selectedRevokePending ? "Removed here" : selectedState.label}
                    {usage ? <span className="kit-num"> · {usage}</span> : null}
                  </span>
                ) : null}
                {selectedEntry ? (
                  <div className="ade-ls-access-actions">
                    {selectedEntry.state === "pending" && selectedEntry.local && !selectedRevokePending ? (
                      <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" disabled={formDisabled} onClick={() => { void resend(selectedEntry); }}>
                        Re-send invite
                      </button>
                    ) : null}
                    {selectedEntry.state === "expired" ? (
                      <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" disabled={formDisabled || atLimit} onClick={() => inviteAgain(selectedEntry)}>
                        Invite again
                      </button>
                    ) : null}
                    {isLiveLaneShare(selectedEntry) && !selectedRevokePending ? (
                      <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" data-tone="crit" disabled={blocked || busy != null} onClick={() => { void remove(selectedEntry); }}>
                        Remove access
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {selectedEntry ? null : <div className="ade-ls-line">They start from your default rights.</div>}
              {selectedEntry && selectedRevokePending ? (
                <Banner layout="inline" model={{
                  id: "lane-share-revoke-pending",
                  tone: "warning",
                  title: "Removed on this computer. The account directory will follow.",
                  detail: "The directory did not answer the revoke. Retry to finish it.",
                  report: false,
                  actions: [{ label: "Retry", onClick: () => { void remove(selectedEntry, true); }, busy: busy === "remove" }],
                }} />
              ) : null}
              {selectedEntry ? <SelectedNote entry={selectedEntry} editable={selectedEditable} laneGone={laneGone} revokePending={selectedRevokePending} /> : null}
            </div>

            <LaneSharePresetPicker
              value={presetOf(draft.rights)}
              disabled={rightsDisabled || (!selectedEntry && atLimit)}
              label={`Access for ${who}`}
              onChange={(preset) => updateDraft({ ...draft, rights: withPreset(draft.rights, preset) })}
            />
            <LaneShareRiskSummary rights={draft.rights} />
            {formError ? (
              <Banner
                layout="inline"
                model={{ id: "lane-share-form-error", tone: "error", title: formError.message, ...(formError.fixable ? { report: false } : {}) }}
              />
            ) : null}
            {notice ? <div className="ade-ls-line" role="status">{notice}</div> : null}
            <div className="ade-ls-scroll">
              <LaneShareRightsPanel
                rights={draft.rights}
                endsAt={draft.endsAt}
                now={now}
                disabled={rightsDisabled}
                cliTyping={cliTyping}
                runtimePin={pin ?? null}
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
