import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopTimeLapse } from "../../../shared/types/macDesktop";

/**
 * The short clip of what a turn did on the lane's screen.
 *
 * Context, not proof. It never reaches the artifact broker, it is built from
 * frames the recorder already held, and it is dismissible — so it has to be
 * cheap to ignore. One card at a time, the most recent turn's, because a thread
 * that accumulates clips is a thread you scroll past.
 *
 * Only rendered when the lane's host is THIS machine. The clip is a file path
 * on the host, and `ade-artifact://` reads the local filesystem: pointing it at
 * a path that exists on another Mac would render a broken video element, which
 * is worse than rendering nothing and saying where the clip is.
 */

export function macDesktopTimeLapseSrc(filePath: string): string {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `ade-artifact://${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
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
  const [timeLapse, setTimeLapse] = useState<MacDesktopTimeLapse | null>(null);

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

  if (!timeLapse || !hostIsLocal) return null;

  return (
    <div
      data-testid="mac-desktop-time-lapse"
      className="pointer-events-auto w-[240px] overflow-hidden rounded-[10px] border border-border bg-surface-raised shadow-float"
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
        src={macDesktopTimeLapseSrc(timeLapse.filePath)}
        className="block w-full"
        muted
        loop
        autoPlay
        playsInline
      />
    </div>
  );
}
