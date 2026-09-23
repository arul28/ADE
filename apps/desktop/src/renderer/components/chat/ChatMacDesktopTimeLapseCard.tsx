import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopTimeLapse } from "../../../shared/types/macDesktop";
import { localArtifactMediaUrl } from "../../../shared/artifactStreamUrl";
import { playableMediaDataUrl } from "../../lib/playableMedia";
import { isWebClientMode } from "../../lib/webClientMode";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * The short clip of what a turn did on the lane's screen.
 *
 * Context, not proof. It never reaches the artifact broker, it is built from
 * frames the recorder already held, and it is dismissible — so it has to be
 * cheap to ignore. One card at a time, the most recent turn's, because a thread
 * that accumulates clips is a thread you scroll past.
 *
 * Only rendered when the lane's host is THIS machine. The clip is a file path
 * on the host: pointing a player at a path that exists on another Mac would
 * render a broken video element, which is worse than rendering nothing.
 */

/**
 * Where the clip plays from, the same way the proof drawer plays a video.
 *
 * The loopback media server first: `ade-artifact://` cannot answer the tail
 * read an MP4 with its index at the end needs, so the clip never loaded there.
 * When there is no server (the web client, an older main) or the path is not
 * inside the project, the host's preview read sends the bytes as a data URL.
 * Null when neither can, and the card then shows nothing.
 */
export async function resolveMacDesktopTimeLapseSrc(args: {
  filePath: string;
  rootPath: string | null;
  pin: OpenProjectBinding | null;
  webClient: boolean;
  mediaBaseUrl: (() => Promise<string | null>) | null;
  readArtifactPreview: ((args: { uri: string }, pin?: OpenProjectBinding | null) => Promise<string | null>) | null;
}): Promise<string | null> {
  // The server reads this computer's project. A clip on a paired machine
  // comes through the preview read, which is routed by the pin.
  const mediaServer = !args.webClient && args.pin?.kind !== "remote" && args.mediaBaseUrl;
  if (mediaServer) {
    const base = await mediaServer().catch(() => null);
    const url = base ? localArtifactMediaUrl(base, args.filePath, args.rootPath) : null;
    if (url) return url;
  }
  if (!args.readArtifactPreview) return null;
  const dataUrl = await args.readArtifactPreview({ uri: args.filePath }, args.pin).catch(() => null);
  return playableMediaDataUrl(dataUrl);
}

export function ChatMacDesktopTimeLapseCard({
  laneId,
  sessionId,
  runtimePin,
  hostIsLocal = true,
}: {
  laneId: string | null;
  sessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  hostIsLocal?: boolean;
}) {
  const scope = useChatRuntimeScope();
  const rootPath = runtimePin?.rootPath ?? scope.rootPath;
  const [timeLapse, setTimeLapse] = useState<MacDesktopTimeLapse | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!laneId || !sessionId) return;
    setTimeLapse(null);
    // This card mounts in every chat, including surfaces whose `window.ade`
    // has no Mac Desktop namespace at all. A missing namespace means no clips,
    // not a thread that fails to render.
    const api = window.ade.macDesktop;
    if (!api) return;
    return api.onEvent((event) => {
      if (event.type !== "time-lapse") return;
      const clip = event.timeLapse;
      if (clip.laneId !== laneId || clip.chatSessionId !== sessionId) return;
      setTimeLapse(clip);
    }, runtimePin);
  }, [laneId, runtimePin, sessionId]);

  const filePath = timeLapse?.filePath ?? null;
  useEffect(() => {
    setSrc(null);
    if (!filePath || !hostIsLocal) return;
    let cancelled = false;
    const computerUse = window.ade.computerUse;
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

  if (!timeLapse || !hostIsLocal || !src) return null;

  return (
    <div
      data-testid="mac-desktop-time-lapse"
      className="pointer-events-auto w-[240px] overflow-hidden rounded-[10px] border border-border bg-surface shadow-float"
    >
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-fg">
          On the lane's screen · {Math.max(1, Math.round(timeLapse.durationMs / 1000))}s
        </span>
        <button
          type="button"
          aria-label="Dismiss"
          className="shrink-0 text-muted-fg hover:text-fg"
          onClick={() => setTimeLapse(null)}
        >
          <X size={11} />
        </button>
      </div>
      <video
        src={src}
        className="block w-full"
        muted
        loop
        autoPlay
        playsInline
      />
    </div>
  );
}
