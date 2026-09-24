import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { AppControlRecordingStatus, OpenProjectBinding } from "../../../shared/types";
import { isWebClientMode } from "../../lib/webClientMode";
import {
  isWorkSurfaceElementMounted,
  useWorkSurfaceElementMounted,
  workSurfaceKey,
} from "../../lib/workToolOnScreen";
import { formatRecordingElapsed, revealProofArtifactRow } from "../shared/recordingFormat";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { resolveMacDesktopTimeLapseSrc } from "./ChatMacDesktopTimeLapseCard";

/**
 * An App Control recording this chat made, in the chat.
 *
 * The same card as the Mac Desktop turn clip, in the same place (the notice
 * overlay over the composer): a short muted line, the video playing muted on
 * a loop, and a dismiss. It appears when a recording this chat owns stops with
 * a file, so the person sees what the agent filed without opening the proof
 * drawer. Open finds the proof row when the drawer is open.
 *
 * Not shown while the App Control pane (or this chat's App Control drawer) is
 * on screen: the pane already shows its own "Saved to proof" receipt, and a
 * second picture of the same app in the thread is a duplicate.
 *
 * Only for a host on this machine: the file is a path on the host.
 */
export function ChatAppControlRecordingCard({
  laneId,
  sessionId,
  runtimePin,
  workScopeKey,
}: {
  laneId: string | null;
  sessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  workScopeKey: string;
}) {
  const scope = useChatRuntimeScope();
  const rootPath = runtimePin?.rootPath ?? scope.rootPath;
  const hostIsLocal = runtimePin?.kind !== "remote";
  const [clip, setClip] = useState<AppControlRecordingStatus | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const paneKey = laneId ? workSurfaceKey("app-control", workScopeKey, laneId) : null;
  const drawerKey = sessionId ? workSurfaceKey("app-control", "chat", sessionId) : null;
  const paneShows = useWorkSurfaceElementMounted(paneKey);
  const drawerShows = useWorkSurfaceElementMounted(drawerKey);
  const keysRef = useRef({ paneKey, drawerKey });
  keysRef.current = { paneKey, drawerKey };

  useEffect(() => {
    if (paneShows || drawerShows) setClip(null);
  }, [drawerShows, paneShows]);

  useEffect(() => {
    setClip(null);
    if (!laneId || !sessionId) return undefined;
    // Mounted in every chat, including surfaces with no App Control namespace.
    const api = window.ade?.appControl;
    if (!api?.onEvent) return undefined;
    return api.onEvent((event) => {
      if (event.type !== "recording-changed" || event.laneId !== laneId) return;
      const status = event.status;
      if (status.running || !status.filePath || status.chatSessionId !== sessionId) return;
      const { paneKey: pane, drawerKey: drawer } = keysRef.current;
      if ((pane && isWorkSurfaceElementMounted(pane)) || (drawer && isWorkSurfaceElementMounted(drawer))) return;
      setClip(status);
    }, runtimePin);
  }, [laneId, runtimePin, sessionId]);

  const filePath = clip?.filePath ?? null;
  useEffect(() => {
    setSrc(null);
    if (!filePath || !hostIsLocal) return undefined;
    let cancelled = false;
    const computerUse = window.ade?.computerUse;
    void resolveMacDesktopTimeLapseSrc({
      filePath,
      rootPath,
      pin: runtimePin,
      webClient: isWebClientMode(),
      mediaBaseUrl: computerUse?.mediaBaseUrl ?? null,
      readArtifactPreview: computerUse?.readArtifactPreview ?? null,
    }).then((next) => {
      if (!cancelled) setSrc(next);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, hostIsLocal, rootPath, runtimePin]);

  if (!clip || !hostIsLocal || !src || paneShows || drawerShows) return null;
  const duration = clip.durationMs != null ? formatRecordingElapsed(clip.durationMs) : null;
  const artifactId = clip.proofArtifactId ?? null;

  return (
    <div
      data-testid="app-control-recording-card"
      className="pointer-events-auto w-[240px] overflow-hidden rounded-[10px] border border-border bg-surface shadow-float"
    >
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-fg" title={clip.caption ?? undefined}>
          {artifactId ? "App Control recording · saved to proof" : "App Control recording"}
          {duration ? ` · ${duration}` : ""}
        </span>
        {artifactId ? (
          <button
            type="button"
            className="shrink-0 text-[11px] font-medium text-accent hover:underline"
            onClick={() => {
              if (revealProofArtifactRow(artifactId)) return;
              if (clip.filePath) void window.ade?.app?.openPath?.(clip.filePath)?.catch?.(() => {});
            }}
          >
            Open
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Dismiss"
          className="shrink-0 text-muted-fg hover:text-fg"
          onClick={() => setClip(null)}
        >
          <X size={11} />
        </button>
      </div>
      <video src={src} className="block w-full" muted loop autoPlay playsInline />
    </div>
  );
}
