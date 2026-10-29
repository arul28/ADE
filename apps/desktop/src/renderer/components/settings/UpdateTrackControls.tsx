import { useCallback, useState } from "react";
import type { AutoUpdateSnapshot, AutoUpdateTrackState } from "../../../shared/types";
import { updateTrackLabel, type UpdateTrack } from "../../../shared/updateTrack";
import { captureError } from "../../../shared/sentry/capture";
import { confirmDialog } from "../ui/dialog";
import { Banner, type BannerModel } from "../ui/notice";
import { ModernRow, ModernRows, SettingsSegmented } from "./primitives";

const TRACK_OPTIONS = [
  { value: "stable", label: "Stable", hint: "Tested releases" },
  { value: "beta", label: "Beta", hint: "New builds every few hours" },
] as const;

type Blocked = { target: UpdateTrack; reason: string };

/**
 * The one line under the control: what is happening with this computer's
 * track right now, or null when nothing is.
 */
function trackStatusModel(args: {
  track: AutoUpdateTrackState;
  snapshot: AutoUpdateSnapshot;
  checking: UpdateTrack | null;
  blocked: Blocked | null;
  clearBlocked: () => void;
  finishSwitch: (target: UpdateTrack) => void;
}): BannerModel | null {
  const { track, snapshot, checking, blocked } = args;
  if (checking) {
    return {
      id: "update-track-checking",
      tone: "info",
      busy: true,
      title: `Checking that ${updateTrackLabel(checking)} can open your projects…`,
    };
  }
  if (blocked) {
    return {
      id: "update-track-blocked",
      tone: "warning",
      title: `This computer stays on ${updateTrackLabel(track.running)}`,
      detail: blocked.reason,
      report: false,
      dismiss: { onDismiss: args.clearBlocked },
    };
  }
  if (track.switching) {
    const label = updateTrackLabel(track.switching);
    // A downloaded switch is an app-wide state: the app banner owns its
    // "Restart and switch" (AutoUpdateBanner), so it is not repeated here.
    if (snapshot.status === "ready") return null;
    if (snapshot.status === "checking" || snapshot.status === "downloading") {
      return {
        id: "update-track-downloading",
        tone: "info",
        busy: true,
        title: snapshot.status === "downloading" && snapshot.version
          ? `Downloading ${label} ${snapshot.version}…`
          : `Looking for the newest ${label} build…`,
      };
    }
    if (snapshot.status === "idle" && snapshot.lastCheckedAt != null) {
      return {
        id: "update-track-none",
        tone: "info",
        title: `There is no ${label} build to switch to right now`,
        detail: `Try again later, or choose ${updateTrackLabel(track.running)} to stay.`,
        actions: [{ label: "Try again", onClick: () => { void window.ade.updateCheckForUpdates(); } }],
      };
    }
    return null;
  }
  if (track.selected !== track.running) {
    return {
      id: "update-track-unfinished",
      tone: "warning",
      title: `The switch to ${updateTrackLabel(track.selected)} didn't finish`,
      detail: `This computer still runs ${updateTrackLabel(track.running)}.`,
      actions: [{ label: "Finish switching", onClick: () => args.finishSwitch(track.selected) }],
    };
  }
  return null;
}

/**
 * Stable or Beta for this computer (docs/plans/beta-track.md).
 *
 * The words stay plain on purpose, because two tracks are easy to confuse:
 * the control shows what this computer follows, and one line under it says
 * what is happening. Both tracks are the same app with the same projects and
 * chats; only which builds arrive changes. Renders nothing for a build with
 * no track (dev, Alpha).
 */
export function UpdateTrackControls({ snapshot }: { snapshot: AutoUpdateSnapshot }) {
  const [checking, setChecking] = useState<UpdateTrack | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const track = snapshot.track;

  const switchTo = useCallback(async (target: UpdateTrack) => {
    if (checking || !track) return;
    setBlocked(null);
    // Back to the track this build is on: nothing installs, so no question.
    if (target === track.running) {
      const result = await window.ade.updateSwitchTrack(target);
      if (!result.ok) setBlocked({ target, reason: result.reason });
      return;
    }
    setChecking(target);
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
          ? `ADE downloads Beta${versionText}, then asks you to restart. Your projects and chats stay, and Beta can have bugs Stable doesn't.`
          : `ADE downloads Stable${versionText}, then asks you to restart. Your projects and chats stay.`,
        confirmLabel: `Switch to ${label}`,
        tone: target === "beta" ? "warning" : "accent",
      });
      if (!confirmed) return;
      const result = await window.ade.updateSwitchTrack(target);
      if (!result.ok) setBlocked({ target, reason: result.reason });
    } catch (error) {
      captureError(error, { tags: { area: "update_track", step: "switch" }, fingerprint: ["update_track", "switch"] });
      setBlocked({ target, reason: "ADE couldn't start the switch. Try again." });
    } finally {
      setChecking(null);
    }
  }, [checking, track]);

  if (!track) return null;

  const status = trackStatusModel({
    track,
    snapshot,
    checking,
    blocked,
    clearBlocked: () => setBlocked(null),
    finishSwitch: (target) => { void switchTo(target); },
  });

  return (
    <ModernRows>
      <ModernRow
        anchor="update-track"
        title="Update track"
        hint="Both use the same projects, chats and settings."
        control={
          <SettingsSegmented<UpdateTrack>
            ariaLabel="Update track"
            value={track.selected}
            options={TRACK_OPTIONS}
            disabled={checking != null || snapshot.status === "installing"}
            onChange={(next) => { void switchTo(next); }}
          />
        }
      >
        {status ? <Banner layout="inline" model={status} /> : null}
      </ModernRow>
    </ModernRows>
  );
}
