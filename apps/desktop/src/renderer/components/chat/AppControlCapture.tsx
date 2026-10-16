import { useCallback, useEffect, useState } from "react";
import { Record, SealCheck } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { cn } from "../ui/cn";
import { MAC_DESKTOP_SECONDARY_BUTTON } from "./MacDesktopStateCard";
import { MacDesktopPermissionCard } from "./MacDesktopPermissionCard";
import { useAppControlRecording } from "./useAppControlRecording";

/**
 * The App Control pane's capture: Record and Save-to-proof, the caption each
 * asks for, and the Screen Recording grant a recording needs. The pane keeps
 * the buttons and the status strip; this owns the state behind them.
 */

export type AppControlCaptionKind = "record" | "proof";

export function useAppControlCapture({
  laneId,
  chatSessionId,
  runtimePin,
  enabled,
  defaultCaption,
  onCaptionOpen,
}: {
  laneId: string | null;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** A session exists; with none there is nothing to capture. */
  enabled: boolean;
  /** The app's page title and the lane; the service files the same default. */
  defaultCaption: string;
  /** A caption prompt opened; the pane closes its other prompt. */
  onCaptionOpen: () => void;
}) {
  const recorder = useAppControlRecording({ laneId, chatSessionId, runtimePin, enabled });
  const [captionDraft, setCaptionDraft] = useState<string | null>(null);
  const [captionFor, setCaptionFor] = useState<AppControlCaptionKind>("record");

  // The prompt for a kind toggles: pressing the same button again closes it.
  const openCaption = useCallback((kind: AppControlCaptionKind) => {
    onCaptionOpen();
    setCaptionDraft((current) => (current != null && captionFor === kind ? null : defaultCaption));
    setCaptionFor(kind);
  }, [captionFor, defaultCaption, onCaptionOpen]);

  const toggleRecording = useCallback(() => {
    if (recorder.running) {
      void recorder.stop();
      return;
    }
    // A person pressing Record wants the file kept, and a caption is what
    // files it as proof. So Record asks for one, prefilled.
    openCaption("record");
  }, [openCaption, recorder]);

  // Proof: one still of the app, filed as proof. Like Record, it asks for a
  // caption, prefilled, because the caption is what a reviewer judges it on.
  const toggleProof = useCallback(() => openCaption("proof"), [openCaption]);

  const closeCaption = useCallback(() => setCaptionDraft(null), []);

  const submitCaption = useCallback(() => {
    const caption = captionDraft?.trim() || defaultCaption;
    setCaptionDraft(null);
    if (captionFor === "proof") void recorder.captureProof(caption);
    else void recorder.start(caption);
  }, [captionDraft, captionFor, defaultCaption, recorder]);

  // A session that went away takes its question with it.
  useEffect(() => {
    if (!enabled) setCaptionDraft(null);
  }, [enabled]);

  return {
    recorder,
    captionDraft,
    captionFor,
    setCaptionDraft,
    toggleRecording,
    toggleProof,
    closeCaption,
    submitCaption,
  };
}

export type AppControlCapture = ReturnType<typeof useAppControlCapture>;

/** The caption prompt Record and Save-to-proof open. Escape cancels it. */
export function AppControlCaptionForm({ capture }: { capture: AppControlCapture }) {
  const { captionDraft, captionFor, recorder } = capture;
  if (captionDraft == null) return null;
  return (
    <form
      aria-label={captionFor === "proof" ? "Save screenshot to proof" : "Record this app"}
      data-testid="app-control-caption-prompt"
      className="mx-2 mt-1.5 flex min-w-0 shrink-0 flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 font-sans text-[12px] text-fg"
      onSubmit={(event) => {
        event.preventDefault();
        capture.submitCaption();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        capture.closeCaption();
      }}
    >
      <label className="flex min-w-0 flex-1 basis-[180px] flex-col gap-1">
        <span className="text-muted-fg">
          {captionFor === "proof" ? "Caption. It files the screenshot as proof." : "Caption. It files the video as proof."}
        </span>
        <input
          autoFocus
          value={captionDraft}
          onChange={(event) => capture.setCaptionDraft(event.target.value)}
          aria-label={captionFor === "proof" ? "Proof caption" : "Recording caption"}
          className="h-7 min-w-0 rounded-[7px] border border-border/70 bg-[color-mix(in_srgb,var(--color-bg)_55%,transparent)] px-2 text-[12px] text-fg outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
        />
      </label>
      <div className="flex shrink-0 items-center gap-2 self-end">
        <button type="button" className={cn(MAC_DESKTOP_SECONDARY_BUTTON, "h-7")} onClick={capture.closeCaption}>
          Cancel
        </button>
        {captionFor === "proof" ? (
          <button
            type="submit"
            data-testid="app-control-proof-save"
            disabled={recorder.proofBusy}
            className={cn(MAC_DESKTOP_SECONDARY_BUTTON, "h-7")}
          >
            <SealCheck size={12} />
            Save to proof
          </button>
        ) : (
          <button
            type="submit"
            data-testid="app-control-record-start"
            disabled={recorder.busy}
            className={cn(
              MAC_DESKTOP_SECONDARY_BUTTON,
              "h-7 border-[color-mix(in_srgb,var(--color-error)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_14%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-error)_22%,transparent)]",
            )}
          >
            <Record size={12} weight="fill" className="text-[var(--color-error)]" />
            Record
          </button>
        )}
      </div>
    </form>
  );
}

/** The Screen Recording grant a refused recording start reported as off. */
export function AppControlRecordingPermissionCard({
  capture,
  machineName,
}: {
  capture: AppControlCapture;
  machineName: string | null;
}) {
  const { recorder } = capture;
  if (recorder.missingPermissions.length === 0 || !recorder.permissions) return null;
  return (
    <div className="mx-2 mt-1.5 shrink-0">
      <MacDesktopPermissionCard
        variant="inline"
        productName="App Control"
        purposes={{ screenRecording: "Records the app's window. Driving the app does not need it." }}
        permissions={{ screenRecording: recorder.permissions.screenRecording, accessibility: "granted" }}
        appName="ADE"
        signing="unknown"
        hostIsLocal={recorder.hostIsLocal}
        machineName={machineName}
        checking={recorder.checkingPermissions}
        lastCheck={recorder.permissionCheck}
        onOpenSettings={recorder.openSettings}
        onCheckAgain={() => void recorder.checkPermissionsAgain()}
      />
    </div>
  );
}
