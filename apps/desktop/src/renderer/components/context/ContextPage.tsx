import React from "react";
import type { ConflictExternalResolverRunSummary, ContextGenerateDocsResult, ContextStatus } from "../../../shared/types";
import { Button } from "../ui/Button";
import { GenerateDocsModal } from "./GenerateDocsModal";

function renderTiming(status: ContextStatus | null): string {
  if (!status?.hostedTiming) return "No timing telemetry yet.";
  const timing = status.hostedTiming;
  return [
    `submit ${timing.submitDurationMs}ms`,
    `queue ${timing.queueWaitMs}ms`,
    `poll ${timing.pollDurationMs}ms`,
    `artifact ${timing.artifactFetchMs}ms`,
    `total ${timing.totalDurationMs}ms`,
    timing.timeoutReason ? `timeout=${timing.timeoutReason}` : "timeout=none"
  ].join(" · ");
}

function summarizeRun(run: ConflictExternalResolverRunSummary): string {
  const status = run.status;
  const provider = run.provider;
  const target = run.targetLaneId;
  const sources = run.sourceLaneIds.join(", ");
  return `${provider} ${status} · ${sources} -> ${target}`;
}

export function ContextPage() {
  const [status, setStatus] = React.useState<ContextStatus | null>(null);
  const [runs, setRuns] = React.useState<ConflictExternalResolverRunSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [lastGenerate, setLastGenerate] = React.useState<ContextGenerateDocsResult | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextRuns] = await Promise.all([
        window.ade.context.getStatus(),
        window.ade.conflicts.listExternalResolverRuns({ limit: 8 })
      ]);
      setStatus(nextStatus);
      setRuns(nextRuns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const openWarningPath = async (pathValue: string | undefined) => {
    const cleaned = (pathValue ?? "").trim();
    if (!cleaned) return;
    try {
      await window.ade.context.openDoc({ path: cleaned });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="h-full overflow-auto px-6 py-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-fg">Context</h1>
          <div className="text-xs text-muted-fg">ADE context health, docs, manifests, and resolver telemetry.</div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => setGenerateOpen(true)} disabled={generateOpen}>
            Generate
          </Button>
        </div>
      </div>

      {error ? <div className="mb-4 rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">{error}</div> : null}

      {status?.warnings?.length ? (
        <section className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <h2 className="text-sm font-semibold text-fg">Context Warnings</h2>
          <div className="mt-2 space-y-2 text-xs text-muted-fg">
            {status.warnings.map((warning, index) => (
              <div key={`${warning.code}-${index}`} className="rounded border border-border/50 bg-bg/40 p-2">
                <div className="font-medium text-fg">{warning.code}</div>
                <div>{warning.message}</div>
                {warning.actionLabel && warning.actionPath ? (
                  <div className="mt-2">
                    <Button size="sm" variant="outline" onClick={() => void openWarningPath(warning.actionPath)}>
                      {warning.actionLabel}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-border/60 bg-panel p-4">
          <h2 className="text-sm font-semibold text-fg">Doc Health</h2>
          <div className="mt-2 space-y-2 text-xs text-muted-fg">
            {(status?.docs ?? []).map((doc) => (
              <div key={doc.id} className="rounded border border-border/50 bg-bg/40 p-2">
                <div className="font-medium text-fg">{doc.label}</div>
                <div>path: {doc.preferredPath}</div>
                <div>exists: {doc.exists ? "yes" : "no"}</div>
                <div>updated: {doc.updatedAt ?? "never"}</div>
                <div>fingerprint: {doc.fingerprint ?? "none"}</div>
                <div>stale reason: {doc.staleReason ?? "none"}</div>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => void window.ade.context.openDoc({ docId: doc.id })}>Open</Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-border/60 bg-panel p-4">
          <h2 className="text-sm font-semibold text-fg">Context Metrics</h2>
          <div className="mt-2 space-y-1 text-xs text-muted-fg">
            <div>canonical docs: {status?.canonicalDocsPresent ?? 0}/{status?.canonicalDocsScanned ?? 0}</div>
            <div>canonical fingerprint: {status?.canonicalDocsFingerprint ?? "-"}</div>
            <div>canonical updated: {status?.canonicalDocsUpdatedAt ?? "never"}</div>
            <div>project export fingerprint: {status?.projectExportFingerprint ?? "none"}</div>
            <div>project export updated: {status?.projectExportUpdatedAt ?? "never"}</div>
            <div>fallback writes: {status?.fallbackWrites ?? 0}</div>
            <div>insufficient-context count: {status?.insufficientContextCount ?? 0}</div>
            <div>manifest project: {status?.contextManifestRefs.project ?? "none"}</div>
            <div>manifest packs: {status?.contextManifestRefs.packs ?? "none"}</div>
            <div>manifest transcripts: {status?.contextManifestRefs.transcripts ?? "none"}</div>
            <div>hosted timing: {renderTiming(status)}</div>
            <div>hosted timeouts: {status?.hostedTimeoutCount ?? 0}</div>
            <div>last timeout reason: {status?.hostedLastTimeoutReason ?? "none"}</div>
          </div>
        </section>

        <section className="rounded-lg border border-border/60 bg-panel p-4 md:col-span-2">
          <h2 className="text-sm font-semibold text-fg">External Resolver Runs</h2>
          <div className="mt-2 space-y-2 text-xs text-muted-fg">
            {runs.length === 0 ? <div>No external resolver runs yet.</div> : null}
            {runs.map((run) => (
              <div key={run.runId} className="rounded border border-border/50 bg-bg/40 p-2">
                <div className="font-medium text-fg">{summarizeRun(run)}</div>
                <div>started: {run.startedAt} · completed: {run.completedAt ?? "-"}</div>
                <div>cwd lane: {run.cwdLaneId}{run.integrationLaneId ? ` · integration: ${run.integrationLaneId}` : ""}</div>
                <div>summary: {run.summary ?? "none"}</div>
                <div>patch: {run.patchPath ?? "none"}</div>
                <div>log: {run.logPath ?? "none"}</div>
                <div>insufficient context: {run.insufficientContext ? "yes" : "no"}</div>
                {run.contextGaps.length ? <div>gaps: {run.contextGaps.map((gap) => gap.message).join(" | ")}</div> : null}
                {run.error ? <div className="text-red-700">error: {run.error}</div> : null}
              </div>
            ))}
          </div>
        </section>
      </div>

      {lastGenerate ? (
        <div className="mt-4 rounded border border-border/60 bg-panel p-4 text-xs text-muted-fg">
          <div className="font-medium text-fg">Last generation</div>
          <div>provider: {lastGenerate.provider}</div>
          <div>generated: {lastGenerate.generatedAt}</div>
          <div>PRD path: {lastGenerate.prdPath}</div>
          <div>Architecture path: {lastGenerate.architecturePath}</div>
          <div>used fallback path: {lastGenerate.usedFallbackPath ? "yes" : "no"}</div>
          {lastGenerate.warnings.length ? (
            <div className="mt-2 space-y-2">
              {lastGenerate.warnings.map((warning, index) => (
                <div key={`${warning.code}-${index}`} className="rounded border border-border/50 bg-bg/40 p-2">
                  <div className="font-medium text-fg">{warning.code}</div>
                  <div>{warning.message}</div>
                  {warning.actionLabel && warning.actionPath ? (
                    <div className="mt-2">
                      <Button size="sm" variant="outline" onClick={() => void openWarningPath(warning.actionPath)}>
                        {warning.actionLabel}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <GenerateDocsModal
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        onCompleted={() => void refresh()}
      />
    </div>
  );
}
