import React, { useEffect, useMemo, useState } from "react";
import type { ComputerUseArtifactOwnerKind, ComputerUseOwnerSnapshot, ComputerUsePolicy } from "../../../shared/types";
import {
  buildComputerUseRoutePresets,
  describeComputerUseLinks,
  formatComputerUseKind,
  formatComputerUseMode,
  summarizeComputerUseProof,
} from "../../lib/computerUse";
import { cn } from "../ui/cn";

function isExternalUri(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function openArtifactUri(uri: string | null) {
  if (!uri) return;
  if (isExternalUri(uri)) {
    void window.ade.app.openExternal(uri);
    return;
  }
  void window.ade.app.revealPath(uri);
}

export function ChatComputerUsePanel({
  laneId,
  sessionId,
  policy,
  snapshot,
  onRefresh,
}: {
  laneId: string | null;
  sessionId: string;
  policy: ComputerUsePolicy;
  snapshot: ComputerUseOwnerSnapshot | null;
  onRefresh: () => void | Promise<void>;
}) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(snapshot?.artifacts[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeKind, setRouteKind] = useState<ComputerUseArtifactOwnerKind>("mission");
  const [routeTargetId, setRouteTargetId] = useState("");

  const selectedArtifact = useMemo(
    () => snapshot?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? snapshot?.artifacts[0] ?? null,
    [selectedArtifactId, snapshot],
  );
  const routePresets = useMemo(
    () => buildComputerUseRoutePresets({ laneId, chatSessionId: sessionId }),
    [laneId, sessionId],
  );

  useEffect(() => {
    setSelectedArtifactId((current) => current && snapshot?.artifacts.some((artifact) => artifact.id === current)
      ? current
      : snapshot?.artifacts[0]?.id ?? null);
  }, [snapshot]);

  if (!snapshot) {
    return (
      <div className="rounded-[var(--chat-radius-card)] border border-white/[0.06] bg-black/10 px-3 py-2 font-mono text-[10px] text-muted-fg/35">
        Computer use is {formatComputerUseMode(policy).toLowerCase()} for this chat. Start a session or capture proof to see backend activity and artifacts here.
      </div>
    );
  }

  const updateReview = async (artifactId: string, reviewState: "accepted" | "needs_more" | "dismissed", workflowState?: "promoted" | "published" | "dismissed") => {
    setBusy(true);
    setError(null);
    try {
      await window.ade.computerUse.updateArtifactReview({
        artifactId,
        reviewState,
        ...(workflowState ? { workflowState } : {}),
      });
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const routeArtifact = async (artifactId: string, ownerKind: ComputerUseArtifactOwnerKind, ownerId: string) => {
    if (!ownerId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.ade.computerUse.routeArtifact({
        artifactId,
        owner: { kind: ownerKind, id: ownerId.trim() },
      });
      setRouteTargetId("");
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-sky-200/80">
            Computer Use
          </div>
          <div className="mt-1 text-[12px] text-fg/78">{snapshot.summary}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center rounded-[var(--chat-radius-pill)] border border-sky-400/18 bg-sky-500/8 px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.14em] text-sky-200/80">
            {formatComputerUseMode(policy)}
          </span>
          <span className={cn(
            "inline-flex items-center rounded-[var(--chat-radius-pill)] border px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.14em]",
            snapshot.usingLocalFallback
              ? "border-amber-400/18 bg-amber-500/8 text-amber-200/80"
              : "border-emerald-400/18 bg-emerald-500/8 text-emerald-200/80",
          )}>
            {snapshot.usingLocalFallback ? "Fallback" : "External"}
          </span>
          <button
            type="button"
            className="rounded-[var(--chat-radius-pill)] border border-white/[0.06] bg-black/10 px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.14em] text-fg/50 hover:text-fg/78"
            onClick={() => void onRefresh()}
            disabled={busy}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 font-mono text-[9px] text-muted-fg/40">
        <span>{summarizeComputerUseProof(snapshot)}</span>
        <span>Backend: {snapshot.activeBackend?.name ?? "not selected"}</span>
        <span>Artifacts: {snapshot.artifacts.length}</span>
      </div>

      {snapshot.activity.length > 0 ? (
        <div className="grid gap-2 lg:grid-cols-2">
          {snapshot.activity.slice(0, 4).map((item) => (
            <div key={item.id} className="rounded-[var(--chat-radius-card)] border border-white/[0.05] bg-black/10 px-3 py-2">
              <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-muted-fg/30">{item.kind.replace(/_/g, " ")}</div>
              <div className="mt-1 text-[11px] text-fg/72">{item.title}</div>
              <div className="mt-1 font-mono text-[9px] text-muted-fg/32">{item.detail}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          {snapshot.artifacts.length === 0 ? (
            <div className="rounded-[var(--chat-radius-card)] border border-white/[0.05] bg-black/10 px-3 py-2 font-mono text-[10px] text-muted-fg/30">
              No screenshots, traces, logs, or verification output retained yet.
            </div>
          ) : snapshot.artifacts.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              onClick={() => setSelectedArtifactId(artifact.id)}
              className={cn(
                "w-full rounded-[var(--chat-radius-card)] border px-3 py-2 text-left transition-colors",
                selectedArtifact?.id === artifact.id
                  ? "border-sky-400/24 bg-sky-500/10"
                  : "border-white/[0.05] bg-black/10 hover:border-white/[0.1]",
              )}
            >
              <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-muted-fg/30">{artifact.backendName}</div>
              <div className="mt-1 text-[11px] text-fg/78">{artifact.title}</div>
              <div className="mt-1 font-mono text-[8px] text-muted-fg/32">
                {formatComputerUseKind(artifact.kind)} • {artifact.reviewState}
              </div>
            </button>
          ))}
        </div>

        {selectedArtifact ? (
          <div className="space-y-3">
            <div className="rounded-[var(--chat-radius-card)] border border-white/[0.05] bg-black/10 px-3 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-muted-fg/30">{selectedArtifact.backendName}</div>
                  <div className="mt-1 text-[13px] text-fg/82">{selectedArtifact.title}</div>
                  {selectedArtifact.description ? (
                    <div className="mt-2 text-[11px] leading-relaxed text-fg/58">{selectedArtifact.description}</div>
                  ) : null}
                </div>
                {selectedArtifact.uri ? (
                  <button
                    type="button"
                    className="rounded-[var(--chat-radius-pill)] border border-white/[0.06] bg-black/10 px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.14em] text-fg/50 hover:text-fg/78"
                    onClick={() => openArtifactUri(selectedArtifact.uri)}
                  >
                    {isExternalUri(selectedArtifact.uri) ? "Open" : "Reveal"}
                  </button>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 font-mono text-[8px] uppercase tracking-[0.14em] text-muted-fg/30">
                <span>{formatComputerUseKind(selectedArtifact.kind)}</span>
                <span>{selectedArtifact.workflowState}</span>
                <span>{describeComputerUseLinks(selectedArtifact.links)}</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded-[var(--chat-radius-pill)] border border-emerald-400/18 bg-emerald-500/8 px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.14em] text-emerald-200/80" onClick={() => void updateReview(selectedArtifact.id, "accepted", "promoted")} disabled={busy}>Accept</button>
              <button type="button" className="rounded-[var(--chat-radius-pill)] border border-amber-400/18 bg-amber-500/8 px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.14em] text-amber-200/80" onClick={() => void updateReview(selectedArtifact.id, "needs_more")} disabled={busy}>Need more</button>
              <button type="button" className="rounded-[var(--chat-radius-pill)] border border-red-400/18 bg-red-500/8 px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.14em] text-red-200/80" onClick={() => void updateReview(selectedArtifact.id, "dismissed", "dismissed")} disabled={busy}>Dismiss</button>
              <button type="button" className="rounded-[var(--chat-radius-pill)] border border-sky-400/18 bg-sky-500/8 px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.14em] text-sky-200/80" onClick={() => void updateReview(selectedArtifact.id, "accepted", "published")} disabled={busy}>Publish</button>
            </div>

            <div className="rounded-[var(--chat-radius-card)] border border-white/[0.05] bg-black/10 px-3 py-3">
              <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-muted-fg/30">Route Artifact</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {routePresets.map((preset) => (
                  <button
                    key={`${preset.owner.kind}:${preset.owner.id}`}
                    type="button"
                    className="rounded-[var(--chat-radius-pill)] border border-white/[0.06] bg-black/10 px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.14em] text-fg/50 hover:text-fg/78"
                    onClick={() => void routeArtifact(selectedArtifact.id, preset.owner.kind, preset.owner.id)}
                    disabled={busy}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-[140px_minmax(0,1fr)_auto]">
                <select
                  value={routeKind}
                  onChange={(event) => setRouteKind(event.target.value as ComputerUseArtifactOwnerKind)}
                  className="h-8 rounded-[var(--chat-radius-pill)] border border-white/[0.06] bg-black/10 px-2 font-mono text-[10px] text-fg/78 outline-none"
                >
                  <option value="mission">mission</option>
                  <option value="lane">lane</option>
                  <option value="github_pr">GitHub PR</option>
                  <option value="linear_issue">linear issue</option>
                </select>
                <input
                  value={routeTargetId}
                  onChange={(event) => setRouteTargetId(event.target.value)}
                  placeholder="Target ID"
                  className="h-8 rounded-[var(--chat-radius-pill)] border border-white/[0.06] bg-black/10 px-2 font-mono text-[10px] text-fg/78 outline-none placeholder:text-muted-fg/24"
                />
                <button
                  type="button"
                  className="rounded-[var(--chat-radius-pill)] border border-white/[0.06] bg-black/10 px-3 font-mono text-[8px] uppercase tracking-[0.14em] text-fg/50 hover:text-fg/78"
                  onClick={() => void routeArtifact(selectedArtifact.id, routeKind, routeTargetId)}
                  disabled={busy || !routeTargetId.trim()}
                >
                  Attach
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {error ? <div className="font-mono text-[9px] text-amber-200/80">{error}</div> : null}
    </div>
  );
}
