import React, { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { HostedBootstrapConfig, HostedJobStatusResult, HostedStatus, PackSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { PackFreshnessIndicator } from "./PackFreshnessIndicator";
import { cn } from "../ui/cn";
import { useNavigate } from "react-router-dom";

type PackScope = "lane" | "project";

const scopeTrigger =
  "inline-flex items-center justify-center rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors";

type AiJobState = {
  jobId: string;
  status: HostedJobStatusResult["status"];
  statusSinceMs: number;
  submittedAt: string | null;
  artifactId: string | null;
  error: string | null;
};

function shortId(id: string): string {
  const trimmed = (id ?? "").trim();
  if (!trimmed) return "";
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8);
}

function PackBody({ pack }: { pack: PackSummary | null }) {
  if (!pack) return <div className="text-xs text-muted-fg">Loading…</div>;
  if (!pack.exists || !pack.body.trim().length) {
    return <div className="text-xs text-muted-fg">Pack file not created yet.</div>;
  }
  return (
    <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/20 p-3 text-[11px] leading-relaxed">
      {pack.body}
    </pre>
  );
}

function hostedReadiness(
  status: HostedStatus | null,
  error: string | null,
  job: AiJobState | null
): { tone: "neutral" | "warn" | "bad"; message: string } | null {
  if (error) return { tone: "bad", message: `Hosted error: ${error}` };
  if (!status) return { tone: "neutral", message: "Hosted: checking status…" };
  if (!status.consentGiven) return { tone: "warn", message: "Hosted: consent not granted (Settings → Provider)." };
  if (!status.apiConfigured) return { tone: "warn", message: "Hosted: missing API config (apply bootstrap in Settings)." };
  if (!status.auth.signedIn) return { tone: "warn", message: "Hosted: not signed in (Settings → Provider)." };
  if (job?.jobId) {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - job.statusSinceMs) / 1000));
    if ((job.status === "queued" || job.status === "processing") && elapsedSec >= 10) {
      const apiBaseUrl = status.apiBaseUrl ?? "not configured";
      const remoteProjectId = status.remoteProjectId ?? "not configured";
      return {
        tone: elapsedSec >= 60 ? "bad" : "warn",
        message: `Last AI job ${shortId(job.jobId)} is ${job.status} for ${elapsedSec}s. If stuck: check your hosted worker/queue health and hosted LLM configuration (apiBaseUrl=${apiBaseUrl}, remoteProjectId=${remoteProjectId}).`
      };
    }
    if (job.status === "failed") {
      return {
        tone: "bad",
        message: `Last AI job ${shortId(job.jobId)} failed${job.error ? `: ${job.error}` : ""}`
      };
    }
  }
  return null;
}

const AI_COOLDOWN_MS = 30_000;

export function PackViewer({ laneId }: { laneId: string | null }) {
  const navigate = useNavigate();
  const providerMode = useAppStore((s) => s.providerMode);

  const [scope, setScope] = useState<PackScope>("lane");
  const [lanePack, setLanePack] = useState<PackSummary | null>(null);
  const [projectPack, setProjectPack] = useState<PackSummary | null>(null);

  const [refreshBusy, setRefreshBusy] = useState(false);
  const [aiQueued, setAiQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const [hostedStatus, setHostedStatus] = useState<HostedStatus | null>(null);
  const [hostedError, setHostedError] = useState<string | null>(null);
  const [hostedBootstrap, setHostedBootstrap] = useState<HostedBootstrapConfig | null>(null);

  const [aiJob, setAiJob] = useState<AiJobState | null>(null);

  const activePack = scope === "project" ? projectPack : lanePack;
  const activeMeta = (activePack?.metadata ?? null) as Record<string, unknown> | null;

  const lanePackKey = laneId ? `lane:${laneId}` : null;

  const refreshTimers = useRef<{ lane?: number | null; project?: number | null }>({});
  const lastAiTriggerRef = useRef<number>(0);

  const fetchLanePack = async () => {
    if (!laneId) return;
    const pack = await window.ade.packs.getLanePack(laneId);
    setLanePack(pack);
  };

  const fetchProjectPack = async () => {
    const pack = await window.ade.packs.getProjectPack();
    setProjectPack(pack);
  };

  const scheduleLaneFetch = () => {
    if (!laneId) return;
    if (refreshTimers.current.lane) window.clearTimeout(refreshTimers.current.lane);
    refreshTimers.current.lane = window.setTimeout(() => {
      refreshTimers.current.lane = null;
      fetchLanePack().catch(() => {});
    }, 120);
  };

  const scheduleProjectFetch = () => {
    if (refreshTimers.current.project) window.clearTimeout(refreshTimers.current.project);
    refreshTimers.current.project = window.setTimeout(() => {
      refreshTimers.current.project = null;
      fetchProjectPack().catch(() => {});
    }, 120);
  };

  const refreshCombined = async () => {
    setRefreshBusy(true);
    setError(null);
    try {
      if (scope === "project") {
        const pack = await window.ade.packs.refreshProjectPack({ laneId });
        setProjectPack(pack);
      } else {
        if (!laneId) return;
        const pack = await window.ade.packs.refreshLanePack(laneId);
        setLanePack(pack);
        await fetchProjectPack().catch(() => {});

        // Rate-limited AI narrative
        const now = Date.now();
        if (providerMode !== "guest" && now - lastAiTriggerRef.current >= AI_COOLDOWN_MS) {
          lastAiTriggerRef.current = now;
          setAiQueued(true);
          setAiError(null);
          try {
            const aiPack = await window.ade.packs.generateNarrative(laneId);
            setLanePack(aiPack);
          } catch (err) {
            setAiError(err instanceof Error ? err.message : String(err));
          } finally {
            setAiQueued(false);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshBusy(false);
    }
  };

  useEffect(() => {
    setLanePack(null);
    setProjectPack(null);
    setError(null);
    setAiError(null);
    setAiQueued(false);
    setAiJob(null);
    if (laneId) fetchLanePack().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    fetchProjectPack().catch(() => setProjectPack(null));
  }, [laneId]);

  useEffect(() => {
    let cancelled = false;
    setHostedStatus(null);
    setHostedError(null);
    setHostedBootstrap(null);
    if (providerMode !== "hosted") return;
    window.ade.hosted
      .getStatus()
      .then((status) => {
        if (cancelled) return;
        setHostedStatus(status);
      })
      .catch((err) => {
        if (cancelled) return;
        setHostedError(err instanceof Error ? err.message : String(err));
      });
    window.ade.hosted
      .getBootstrapConfig()
      .then((config) => {
        if (cancelled) return;
        setHostedBootstrap(config);
      })
      .catch(() => {
        if (cancelled) return;
        setHostedBootstrap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [providerMode]);

  useEffect(() => {
    if (!laneId) return;
    const unsub = window.ade.packs.onEvent((ev) => {
      if (lanePackKey && ev.packKey === lanePackKey) {
        if (ev.eventType === "narrative_requested") {
          setAiQueued(true);
          const jobId = typeof ev.payload?.jobId === "string" ? (ev.payload.jobId as string) : null;
          const statusRaw = typeof ev.payload?.status === "string" ? (ev.payload.status as string) : "queued";
          const status =
            statusRaw === "queued" || statusRaw === "processing" || statusRaw === "completed" || statusRaw === "failed"
              ? statusRaw
              : "queued";
          if (jobId) {
            setAiJob({
              jobId,
              status,
              statusSinceMs: Date.now(),
              submittedAt: typeof ev.payload?.submittedAt === "string" ? (ev.payload.submittedAt as string) : null,
              artifactId: null,
              error: null
            });
          }
        }
        if (ev.eventType === "narrative_failed") {
          setAiQueued(false);
          const msg = typeof ev.payload?.error === "string" ? (ev.payload.error as string) : "AI update failed.";
          setAiError(msg);
          const jobId = typeof ev.payload?.jobId === "string" ? (ev.payload.jobId as string) : null;
          if (jobId) {
            setAiJob((prev) =>
              prev?.jobId === jobId
                ? { ...prev, status: "failed", statusSinceMs: Date.now(), error: msg }
                : {
                    jobId,
                    status: "failed",
                    statusSinceMs: Date.now(),
                    submittedAt: typeof ev.payload?.submittedAt === "string" ? (ev.payload.submittedAt as string) : null,
                    artifactId: null,
                    error: msg
                  }
            );
          }
        }
        if (ev.eventType === "narrative_update") {
          setAiQueued(false);
          setAiError(null);
          const jobId = typeof ev.payload?.jobId === "string" ? (ev.payload.jobId as string) : null;
          const artifactId = typeof ev.payload?.artifactId === "string" ? (ev.payload.artifactId as string) : null;
          if (jobId) {
            setAiJob((prev) =>
              prev?.jobId === jobId
                ? { ...prev, status: "completed", statusSinceMs: Date.now(), artifactId, error: null }
                : {
                    jobId,
                    status: "completed",
                    statusSinceMs: Date.now(),
                    submittedAt: typeof ev.payload?.submittedAt === "string" ? (ev.payload.submittedAt as string) : null,
                    artifactId,
                    error: null
                  }
            );
          }
        }
        if (ev.eventType === "refresh_triggered" || ev.eventType === "narrative_update" || ev.eventType === "narrative_failed") {
          scheduleLaneFetch();
        }
      }
      if (ev.packKey === "project" && (ev.eventType === "refresh_triggered" || ev.eventType === "narrative_update")) {
        scheduleProjectFetch();
      }
    });
    return () => {
      try {
        unsub();
      } catch {
        // ignore
      }
    };
  }, [laneId, lanePackKey]);

  const aiHint = useMemo(() => {
    if (scope !== "lane") return null;
    if (providerMode === "guest") {
      return { tone: "warn" as const, message: "AI details are disabled in Guest Mode. Set up Hosted or BYOK in Settings." };
    }
    if (providerMode === "hosted") {
      const ready = hostedReadiness(hostedStatus, hostedError, aiJob);
      if (ready) return ready;
      if (aiJob?.jobId) {
        const elapsedSec = Math.max(0, Math.floor((Date.now() - aiJob.statusSinceMs) / 1000));
        if (aiJob.status === "queued") {
          return { tone: "neutral" as const, message: `Job ${shortId(aiJob.jobId)} queued for ${elapsedSec}s…` };
        }
        if (aiJob.status === "processing") {
          return { tone: "neutral" as const, message: `Job ${shortId(aiJob.jobId)} processing for ${elapsedSec}s…` };
        }
        if (aiJob.status === "completed") {
          return { tone: "good" as const, message: `Job ${shortId(aiJob.jobId)} complete.` };
        }
        if (aiJob.status === "failed") {
          return { tone: "bad" as const, message: `Job ${shortId(aiJob.jobId)} failed${aiJob.error ? `: ${aiJob.error}` : ""}` };
        }
      }
      if (aiQueued) {
        return { tone: "neutral" as const, message: "AI update queued…" };
      }
      return null;
    }
    if (providerMode === "byok") {
      if (aiQueued) {
        return { tone: "neutral" as const, message: "AI update queued…" };
      }
      return null;
    }
    return null;
  }, [scope, providerMode, hostedStatus, hostedError, aiQueued, aiJob]);

  const aiMetaHint = useMemo(() => {
    if (scope !== "lane") return null;
    if (!activePack) return null;
    const hasAi = Boolean(activePack.narrativeUpdatedAt);
    if (!hasAi) {
      if (providerMode === "guest") return null;
      return { tone: "warn" as const, message: "AI details: not generated yet for this lane pack." };
    }

    const provider = typeof activeMeta?.provider === "string" ? (activeMeta.provider as string) : null;
    const model = typeof activeMeta?.model === "string" ? (activeMeta.model as string) : null;
    if (provider === "mock") {
      return {
        tone: "warn" as const,
        message: "AI details: mock mode (no real model calls). Configure hosted LLM provider (Gemini Flash) to get real summaries."
      };
    }
    if (provider || model) {
      return { tone: "neutral" as const, message: `AI details: ${provider ?? "provider"}${model ? ` · ${model}` : ""}` };
    }
    return { tone: "neutral" as const, message: "AI details: generated (provider details not available)." };
  }, [activePack, activeMeta, providerMode, scope]);

  useEffect(() => {
    if (providerMode !== "hosted") return;
    if (!aiJob?.jobId) return;
    if (aiJob.status === "completed" || aiJob.status === "failed") return;

    let cancelled = false;
    let delayMs = 700;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const status = await window.ade.hosted.getJob(aiJob.jobId);
        if (cancelled) return;
        setAiJob((prev) => {
          if (!prev || prev.jobId !== aiJob.jobId) return prev;
          const nextStatus = status.status;
          const statusChanged = nextStatus !== prev.status;
          return {
            ...prev,
            status: nextStatus,
            statusSinceMs: statusChanged ? Date.now() : prev.statusSinceMs,
            submittedAt: status.submittedAt ?? prev.submittedAt,
            artifactId: status.artifactId ?? prev.artifactId,
            error: status.error?.message ?? prev.error
          };
        });

        if (status.status === "completed" || status.status === "failed") {
          return;
        }
      } catch {
        // Keep polling; hosted failures are surfaced via aiError + status cards.
      }

      delayMs = Math.min(4000, Math.max(700, Math.floor(delayMs * 1.8)));
      timer = window.setTimeout(() => void tick(), delayMs);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [providerMode, aiJob?.jobId, aiJob?.status]);

  if (!laneId && scope === "lane") {
    return <EmptyState title="No lane selected" description="Select a lane to view its pack." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-border/40 bg-card/50 p-0.5">
            <button
              type="button"
              className={cn(scopeTrigger, scope === "lane" ? "bg-muted text-fg shadow-sm border border-accent/40" : "text-muted-fg hover:bg-muted/50 hover:text-fg border border-transparent")}
              onClick={() => setScope("lane")}
              title="Lane pack"
            >
              Lane
            </button>
            <button
              type="button"
              className={cn(scopeTrigger, scope === "project" ? "bg-muted text-fg shadow-sm border border-accent/40" : "text-muted-fg hover:bg-muted/50 hover:text-fg border border-transparent")}
              onClick={() => setScope("project")}
              title="Project pack"
            >
              Project
            </button>
          </div>
          <div className="text-xs font-semibold text-muted-fg">{scope === "lane" ? "Lane pack" : "Project pack"}</div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" title="Refresh pack (includes AI narrative)" onClick={() => refreshCombined().catch(() => {})} disabled={refreshBusy}>
            <RefreshCw className={cn("h-4 w-4", refreshBusy && "animate-spin")} />
            {refreshBusy ? "Refreshing" : "Refresh"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate("/context")}>
            Open Context Tab
          </Button>
        </div>
      </div>

      <PackFreshnessIndicator
        deterministicUpdatedAt={activePack?.deterministicUpdatedAt ?? null}
        narrativeUpdatedAt={activePack?.narrativeUpdatedAt ?? null}
      />

      {aiMetaHint ? (
        <div
          className={cn(
            "rounded-lg p-2 text-xs",
            aiMetaHint.tone === "warn"
              ? "bg-amber-500/10 text-amber-200"
              : "bg-card/40 text-muted-fg"
          )}
        >
          {aiMetaHint.message}
        </div>
      ) : null}

      {aiHint ? (
        <div
          className={cn(
            "rounded-lg p-2 text-xs",
            aiHint.tone === "bad"
              ? "bg-red-500/10 text-red-200"
              : aiHint.tone === "warn"
                ? "bg-amber-500/10 text-amber-200"
                : "bg-card/40 text-muted-fg"
          )}
        >
          {aiHint.message}
        </div>
      ) : null}

      {providerMode === "hosted" && scope === "lane" ? (
        <div className="rounded-lg shadow-card bg-card/40 p-2 text-xs">
          <div className="mb-1 text-[13px] font-semibold text-fg/70">Hosted Health</div>
          <div className="grid grid-cols-1 gap-1 text-[11px] text-muted-fg">
            <div>Consent granted: {hostedStatus?.consentGiven ? "yes" : "no"}</div>
            <div>Bootstrap file: {hostedBootstrap ? `yes (${hostedBootstrap.stage})` : "no"}</div>
            <div>Bootstrap applied: {hostedStatus?.apiConfigured ? "yes" : "no"}</div>
            <div>API base URL: {hostedStatus?.apiBaseUrl ?? "not configured"}</div>
            <div>
              Signed in:{" "}
              {hostedStatus?.auth.signedIn ? `yes${hostedStatus.auth.email ? ` (${hostedStatus.auth.email})` : ""}` : "no"}
            </div>
            <div>Remote project ID: {hostedStatus?.remoteProjectId ?? "not configured"}</div>
            <div>
              Last job:{" "}
              {aiJob
                ? `${shortId(aiJob.jobId)} · ${aiJob.status}${aiJob.status === "queued" || aiJob.status === "processing"
                    ? ` · ${Math.max(0, Math.floor((Date.now() - aiJob.statusSinceMs) / 1000))}s`
                    : ""}`
                : "none"}
            </div>
          </div>
          {aiJob && (aiJob.status === "queued" || aiJob.status === "processing") ? (
            <div className="mt-2 rounded-lg bg-amber-500/10 p-2 text-[11px] text-amber-200">
              Job {shortId(aiJob.jobId)} has been {aiJob.status} for{" "}
              {Math.max(0, Math.floor((Date.now() - aiJob.statusSinceMs) / 1000))}s. Expected: &lt; 10s queued. Check: hosted worker/queue
              health and hosted LLM config (apiBaseUrl={hostedStatus?.apiBaseUrl ?? "not configured"}, remoteProjectId=
              {hostedStatus?.remoteProjectId ?? "not configured"}).
            </div>
          ) : null}
          {aiJob && aiJob.status === "failed" ? (
            <div className="mt-2 rounded-lg bg-red-500/10 p-2 text-[11px] text-red-300">
              Job {shortId(aiJob.jobId)} failed{aiJob.error ? `: ${aiJob.error}` : "."}
            </div>
          ) : null}
        </div>
      ) : null}

      {aiError ? (
        <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-300">
          <div>{aiError}</div>
          {aiJob?.jobId ? (
            <div className="mt-1 text-[11px] text-red-200">
              job {shortId(aiJob.jobId)} · status {aiJob.status}
              {aiJob.status === "queued" || aiJob.status === "processing"
                ? ` · ${Math.max(0, Math.floor((Date.now() - aiJob.statusSinceMs) / 1000))}s`
                : ""}
            </div>
          ) : null}
          {aiJob?.status === "queued" ? (
            <div className="mt-1 text-[11px] text-red-200">
              If this stays queued: check your hosted worker/queue health and hosted LLM configuration (apiBaseUrl={hostedStatus?.apiBaseUrl ?? "not configured"},
              remoteProjectId={hostedStatus?.remoteProjectId ?? "not configured"}).
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-300">{error}</div> : null}

      <PackBody pack={activePack} />
      {activePack?.path ? <div className="truncate text-[11px] text-muted-fg">{activePack.path}</div> : null}
    </div>
  );
}
