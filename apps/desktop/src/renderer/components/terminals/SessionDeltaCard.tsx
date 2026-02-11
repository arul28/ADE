import React, { useEffect, useState } from "react";
import type { SessionDeltaSummary } from "../../../shared/types";
import { Chip } from "../ui/Chip";

export function SessionDeltaCard({ sessionId }: { sessionId: string }) {
  const [delta, setDelta] = useState<SessionDeltaSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDelta(null);

    window.ade.sessions
      .getDelta(sessionId)
      .then((value) => {
        if (cancelled) return;
        setDelta(value);
      })
      .catch(() => {
        if (cancelled) return;
        setDelta(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className="rounded border border-border bg-card/70 p-2 text-xs">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">Session Delta</div>
      {loading ? (
        <div className="text-[11px] text-muted-fg">Computing…</div>
      ) : !delta ? (
        <div className="text-[11px] text-muted-fg">No deterministic delta captured yet.</div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <Chip className="text-[10px]">files {delta.filesChanged}</Chip>
            <Chip className="text-[10px]">+{delta.insertions}</Chip>
            <Chip className="text-[10px]">-{delta.deletions}</Chip>
          </div>
          {delta.touchedFiles.length ? (
            <div className="max-h-24 overflow-auto rounded border border-border bg-card/60 p-2 text-[11px] leading-relaxed">
              {delta.touchedFiles.slice(0, 20).map((file) => (
                <div key={file}>{file}</div>
              ))}
            </div>
          ) : null}
          {delta.failureLines.length ? (
            <div className="space-y-1 rounded border border-red-900 bg-red-950/20 p-2 text-[11px] text-red-300">
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
