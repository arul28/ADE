import { useEffect, useState } from "react";
import type { SessionDeltaSummary, TerminalSessionDetail } from "../../../shared/types";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";

export function SessionDeltaCard({ sessionId, className }: { sessionId: string; className?: string }) {
  const [delta, setDelta] = useState<SessionDeltaSummary | null>(null);
  const [session, setSession] = useState<TerminalSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDelta(null);
    setSession(null);

    Promise.allSettled([window.ade.sessions.getDelta(sessionId), window.ade.sessions.get(sessionId)]).then((results) => {
      if (cancelled) return;
      const [deltaResult, sessionResult] = results;
      if (deltaResult.status === "fulfilled") setDelta(deltaResult.value);
      if (sessionResult.status === "fulfilled") setSession(sessionResult.value);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div
      className={cn(
        "rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3 text-xs backdrop-blur-sm",
        className,
      )}
    >
      <div className="mb-1.5 text-[10px] font-medium text-muted-fg/55">Session delta</div>
      {loading ? (
        <div className="text-[11px] text-muted-fg">Computing…</div>
      ) : !delta ? (
        <div className="text-[11px] text-muted-fg">No deterministic delta captured yet.</div>
      ) : (
        <div className="space-y-2">
          {session?.summary ? <div className="text-[11px] text-muted-fg">{session.summary}</div> : null}
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <Chip className="text-[10px]">files {delta.filesChanged}</Chip>
            <Chip className="text-[10px]">+{delta.insertions}</Chip>
            <Chip className="text-[10px]">-{delta.deletions}</Chip>
          </div>
          {delta.touchedFiles.length ? (
            <div className="max-h-24 overflow-auto rounded-lg bg-card/60 p-2 text-[11px] leading-relaxed">
              {delta.touchedFiles.slice(0, 20).map((file) => (
                <div key={file}>{file}</div>
              ))}
            </div>
          ) : null}
          {delta.failureLines.length ? (
            <div className="space-y-1 rounded-lg bg-red-500/10 p-2 text-[11px] text-red-300">
              {delta.failureLines.map((line, index) => (
                <div key={`${index}:${line}`}>{line}</div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
