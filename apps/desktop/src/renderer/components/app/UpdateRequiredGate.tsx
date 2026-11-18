import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, ArrowSquareOut, CircleNotch, Copy } from "@phosphor-icons/react";
import type { ClientUpdateGateState, DesktopUpdateRequirement } from "../../../shared/clientUpdateGate";
import type { AutoUpdateSnapshot } from "../../../shared/types";
import { UNKNOWN_UPDATE_IMPACT } from "../../../shared/updateImpact";
import { compareUpdateVersions } from "../../../shared/updateVersions";
import { refreshClientUpdateGate, useClientUpdateGate } from "../../state/clientUpdateGateStore";
import { isWebClientMode } from "../../lib/webClientMode";
import { openExternalUrl } from "../../lib/openExternal";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { GateBackdrop } from "../onboarding/GateBackdrop";
import { AdeWordmark } from "../ui/AdeWordmark";
import { Banner } from "../ui/notice";
import { ViewportOverlayHost } from "../ui/ViewportOverlayHost";
import { resumableChatCount } from "../remoteTargets/MachineUpdateImpact";
import { useAutoUpdateSnapshot } from "./useAutoUpdateSnapshot";
import { showToast } from "./toast/toastStore";
import "../onboarding/launchGateGlass.css";

/**
 * "Update ADE to keep working": the full window, with no way past it, while
 * this build is below the owner's minimum (`desktopUpdateRequirement`, read by
 * main). Signed in or not; above the launch gate, under dialogs and toasts.
 *
 * Nothing stops while it shows: the brain keeps running agents until the
 * update restarts ADE, and chats resume after it as any update's do. "Update
 * now" runs the ordinary updater (check, download, restart). The download
 * page, and the Homebrew command for a Homebrew install, always show, and
 * "Quit ADE" always works, so a failed updater never leaves anyone stuck.
 */
export function UpdateRequiredGate() {
  const gate = useClientUpdateGate();
  if (isWebClientMode() || !gate.self.required) return null;
  return <UpdateRequiredScreen gate={gate} requirement={gate.self} />;
}

const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

function versionMeets(version: string | null | undefined, minimum: string): boolean {
  return Boolean(version) && compareUpdateVersions(version!, minimum) >= 0;
}

function UpdateRequiredScreen({
  gate,
  requirement,
}: {
  gate: ClientUpdateGateState;
  requirement: Extract<DesktopUpdateRequirement, { required: true }>;
}) {
  const snapshot = useAutoUpdateSnapshot();
  const snapshotRef = useRef<AutoUpdateSnapshot>(snapshot);
  snapshotRef.current = snapshot;
  // The person pressed Update now in this window: a finished download restarts.
  const [wanted, setWanted] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const installStarted = useRef(false);

  const canSelfUpdate = gate.install === "updater" && snapshot.installMode !== "manual";
  const readyToInstall = snapshot.status === "ready" && versionMeets(snapshot.version, requirement.minimumVersion);

  const install = useCallback(async () => {
    if (installStarted.current) return;
    installStarted.current = true;
    setRestarting(true);
    setProblem(null);
    const impact = await Promise.resolve()
      .then(() => window.ade.updateGetInstallImpact())
      .catch(() => ({ ...UNKNOWN_UPDATE_IMPACT, connectedPhones: [] }));
    // The same rule as any update: chats resume when the setting allows.
    const resumeChats = resumableChatCount(impact) > 0 && impact.continueAfterRestart !== false;
    let started = false;
    try {
      started = await window.ade.updateQuitAndInstall({ resumeChats });
    } catch {
      started = false;
    }
    if (!started) {
      installStarted.current = false;
      setRestarting(false);
      setProblem("ADE could not restart to install the update. Try again, or download it from ade-app.dev.");
    }
  }, []);

  const updateNow = useCallback(async () => {
    setWanted(true);
    setProblem(null);
    if (snapshotRef.current.status === "ready" && versionMeets(snapshotRef.current.version, requirement.minimumVersion)) {
      void install();
      return;
    }
    // Settles when the check and the download it starts are over.
    try {
      await window.ade.updateCheckForUpdates();
    } catch {
      // The snapshot carries the failure.
    }
    const after = snapshotRef.current;
    if (after.status === "error") return;
    if (after.status === "ready" && !versionMeets(after.version, requirement.minimumVersion)) {
      setProblem(`ADE found ${after.version ?? "an older version"}, but needs ${requirement.minimumVersion} or newer. Try again in a few minutes, or download it from ade-app.dev.`);
    } else if (after.status === "idle") {
      setProblem("ADE did not find the update yet. Try again in a few minutes, or download it from ade-app.dev.");
    }
  }, [install, requirement.minimumVersion]);

  // The download the person asked for finished: restart into it.
  useEffect(() => {
    if (wanted && readyToInstall && !problem) void install();
  }, [install, problem, readyToInstall, wanted]);

  const updaterError = wanted && snapshot.status === "error" ? snapshot.error?.trim() || "The update did not download." : null;
  const shownProblem = updaterError ?? problem;
  const busyLabel = restarting || snapshot.status === "installing"
    ? "Restarting ADE…"
    : wanted && snapshot.status === "checking"
      ? "Finding the update…"
      : wanted && snapshot.status === "downloading"
        ? `Downloading${snapshot.progressPercent != null ? ` ${Math.round(snapshot.progressPercent)}%` : "…"}`
        : null;

  const copyCommand = useCallback(async (command: string) => {
    const copied = await copyTextToClipboard(command);
    showToast({ tone: copied ? "success" : "error", title: copied ? "Command copied" : "Couldn't copy the command", message: copied ? "Paste it in Terminal." : command, report: false });
  }, []);

  return (
    <ViewportOverlayHost layer="updateRequired" testId="update-required-gate">
      <div
        className="ade-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-required-title"
        style={{ pointerEvents: "auto" }}
      >
        <GateBackdrop />
        <div
          aria-hidden="true"
          data-app-region="drag"
          style={{ position: "absolute", inset: "0 0 auto", height: 44, WebkitAppRegion: "drag" } as CSSProperties}
        />
        <div className="ade-gate-stack">
          <div className="ade-glass-card" style={NO_DRAG}>
            <span className="ade-glass-mark">
              <AdeWordmark alt="ADE" draggable={false} />
            </span>
            <h1 id="update-required-title" className="ade-glass-title">Update ADE to keep working</h1>
            <p className="ade-glass-sub">
              This version of ADE is no longer supported. Your lanes, chats and work are saved. They will be here after the update.
            </p>
            <p className="ade-glass-sub" data-testid="update-required-versions">
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{requirement.currentVersion}</span>
              {" → "}
              <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--color-fg)" }}>{requirement.targetVersion}</span>
            </p>

            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              {canSelfUpdate ? (
                <button
                  type="button"
                  className="ade-glass-primary"
                  disabled={busyLabel != null}
                  onClick={() => void updateNow()}
                >
                  {busyLabel ? <CircleNotch size={16} weight="bold" className="animate-spin" /> : null}
                  {busyLabel ?? (shownProblem ? "Try again" : "Update now")}
                  {busyLabel ? null : <ArrowRight size={16} weight="bold" className="ade-glass-primary-arrow" />}
                </button>
              ) : null}
              <button
                type="button"
                className={canSelfUpdate ? "ade-glass-secondary" : "ade-glass-primary"}
                onClick={() => openExternalUrl(gate.downloadUrl)}
              >
                Download from ade-app.dev
                <ArrowSquareOut size={14} weight="bold" />
              </button>
              {gate.packageManagerCommand ? (
                <button
                  type="button"
                  className="ade-glass-link"
                  title="Copy the command"
                  onClick={() => void copyCommand(gate.packageManagerCommand!)}
                >
                  Installed with Homebrew? Run <code style={{ whiteSpace: "nowrap" }}>{gate.packageManagerCommand}</code>
                  <Copy size={12} weight="bold" />
                </button>
              ) : null}
            </div>

            {shownProblem ? (
              <Banner
                layout="inline"
                style={{ marginTop: 14, textAlign: "left" }}
                model={{
                  id: "update-required-error",
                  tone: "error",
                  title: "The update did not finish",
                  detail: shownProblem,
                  report: { surface: "update_required", code: "update_failed", technicalDetail: shownProblem },
                  actions: canSelfUpdate ? [{ label: "Retry", onClick: () => void updateNow() }] : [],
                }}
              />
            ) : null}
            {!canSelfUpdate ? (
              <p className="ade-glass-sub" style={{ fontSize: 12 }}>
                This copy of ADE cannot install updates itself. Download the new version and install it.
              </p>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 4, ...NO_DRAG }}>
            <button type="button" className="ade-glass-link" onClick={() => void refreshClientUpdateGate()}>
              Check again
            </button>
            {typeof window.ade?.clientUpdateGate?.quit === "function" ? (
              <button type="button" className="ade-glass-link" onClick={() => void window.ade.clientUpdateGate.quit?.()}>
                Quit ADE
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </ViewportOverlayHost>
  );
}
