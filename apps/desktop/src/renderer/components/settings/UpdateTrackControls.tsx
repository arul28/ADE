import { useCallback, useState } from "react";
import type { AutoUpdateSnapshot } from "../../../shared/types";
import { updateTrackLabel, type UpdateTrack } from "../../../shared/updateTrack";
import { requestDownloadedUpdateInstall } from "../app/autoUpdateInstallAction";
import { confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { ModernRow, ModernRows, SettingsSegmented } from "./primitives";

const TRACK_OPTIONS = [
  { value: "stable", label: "Stable", hint: "Tested releases" },
  { value: "beta", label: "Beta", hint: "New every few hours" },
] as const;

type Busy = { target: UpdateTrack } | null;

/**
 * Stable or Beta for this computer (docs/plans/beta-track.md).
 *
 * The words stay plain on purpose, because two tracks are easy to confuse:
 * the control shows what this computer follows, and one line under it says
 * what is happening. Both tracks are the same app with the same projects and
 * chats; only which builds arrive changes.
 */
export function UpdateTrackControls({ snapshot }: { snapshot: AutoUpdateSnapshot }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [blocked, setBlocked] = useState<{ target: UpdateTrack; reason: string } | null>(null);
  const track = snapshot.track;

  const switchTo = useCallback(async (target: UpdateTrack) => {
    if (busy || !track) return;
    setBlocked(null);
    // Back to the track this build is on: nothing installs, so no question.
    if (target === track.running) {
      const result = await window.ade.updateSwitchTrack(target);
      if (!result.ok) setBlocked({ target, reason: result.reason });
      return;
    }
    setBusy({ target });
    try {
      const check = await window.ade.updateCheckTrackSwitch(target);
      if (!check.allowed) {
        setBlocked({ target, reason: check.reason });
        return;
      }
      const label = updateTrackLabel(target);
      const versionText = check.targetVersion ? ` ${check.targetVersion}` : "";
      const confirmed = await confirmDialog({
        title: `Switch this computer to ${label}?`,
        message: target === "beta"
          ? `ADE downloads Beta${versionText} and then asks you to restart. Your projects, chats and settings stay. Beta gets new builds from main every few hours, so it can have bugs Stable doesn't. You can switch back to Stable later.`
          : `ADE downloads Stable${versionText} and then asks you to restart. Your projects, chats and settings stay.`,
        confirmLabel: `Switch to ${label}`,
        tone: target === "beta" ? "warning" : "accent",
      });
      if (!confirmed) return;
      const result = await window.ade.updateSwitchTrack(target);
      if (!result.ok) setBlocked({ target, reason: result.reason });
    } catch {
      setBlocked({ target, reason: "ADE couldn't start the switch. Try again." });
    } finally {
      setBusy(null);
    }
  }, [busy, track]);

  if (!track) return null;

  const selectedLabel = updateTrackLabel(track.selected);
  const unfinished = track.selected !== track.running && !track.switching;
  const switching = track.switching;
  const switchingLabel = switching ? updateTrackLabel(switching) : null;
  const readyForSwitch = Boolean(
    switching && snapshot.status === "ready" && snapshot.version,
  );

  let status: React.ReactNode = null;
  if (busy) {
    status = (
      <Banner
        layout="inline"
        model={{
          id: "update-track-checking",
          tone: "info",
          busy: true,
          title: `Checking that ${updateTrackLabel(busy.target)} can open your projects…`,
        }}
      />
    );
  } else if (blocked) {
    status = (
      <Banner
        layout="inline"
        model={{
          id: "update-track-blocked",
          tone: "warning",
          title: `This computer stays on ${updateTrackLabel(track.running)}`,
          detail: blocked.reason,
          report: false,
          dismiss: { onDismiss: () => setBlocked(null) },
        }}
      />
    );
  } else if (readyForSwitch && switchingLabel) {
    status = (
      <Banner
        layout="inline"
        model={{
          id: "update-track-ready",
          tone: "accent",
          title: `${switchingLabel} ${snapshot.version} is ready`,
          detail: `Restart ADE to finish switching to ${switchingLabel}.`,
          actions: [{
            label: "Restart and switch",
            onClick: () => { void requestDownloadedUpdateInstall(snapshot); },
          }],
        }}
      />
    );
  } else if (switching && switchingLabel && (snapshot.status === "checking" || snapshot.status === "downloading")) {
    status = (
      <Banner
        layout="inline"
        model={{
          id: "update-track-downloading",
          tone: "info",
          busy: true,
          title: snapshot.status === "downloading" && snapshot.version
            ? `Downloading ${switchingLabel} ${snapshot.version}…`
            : `Looking for the newest ${switchingLabel} build…`,
        }}
      />
    );
  } else if (unfinished) {
    status = (
      <Banner
        layout="inline"
        model={{
          id: "update-track-unfinished",
          tone: "warning",
          title: `The switch to ${selectedLabel} didn't finish`,
          detail: `This computer still runs ${updateTrackLabel(track.running)}.`,
          actions: [{ label: "Finish switching", onClick: () => { void switchTo(track.selected); } }],
        }}
      />
    );
  }

  return (
    <ModernRows>
      <ModernRow
        anchor="update-track"
        title="Update track"
        hint="Stable gets releases after they ran on Beta. Beta gets new builds from main every few hours. Both use the same projects and chats."
        control={
          <SettingsSegmented<UpdateTrack>
            ariaLabel="Update track"
            value={track.selected}
            options={TRACK_OPTIONS}
            disabled={busy != null || snapshot.status === "installing"}
            onChange={(next) => { void switchTo(next); }}
          />
        }
      >
        {status}
      </ModernRow>
    </ModernRows>
  );
}
