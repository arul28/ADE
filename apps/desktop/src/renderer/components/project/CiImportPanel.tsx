import React from "react";
import { ArrowsClockwise, ShieldWarning, Wrench } from "@phosphor-icons/react";
import type { CiImportMode, CiJobCandidate, CiScanResult } from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { formatDate } from "../../lib/format";

function safetyTone(safety: CiJobCandidate["safety"]): string {
  if (safety === "local-safe") return "text-emerald-200 bg-emerald-900/15";
  if (safety === "ci-only") return "text-red-200 bg-red-900/15";
  return "text-muted-fg bg-card/40";
}

function inferKind(job: CiJobCandidate): "testSuite" | "process" {
  const cmd = (job.suggestedCommandLine ?? "").toLowerCase();
  if (/(test|pytest|go\s+test|cargo\s+test)\b/.test(cmd)) return "testSuite";
  if (/\blint\b|typecheck\b/.test(cmd)) return "testSuite";
  return "process";
}

export function CiImportPanel({ onImported }: { onImported?: () => void }) {
  const [scan, setScan] = React.useState<CiScanResult | null>(null);
  const [scanBusy, setScanBusy] = React.useState(false);
  const [importBusy, setImportBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [query, setQuery] = React.useState("");
  const [mode, setMode] = React.useState<CiImportMode>("import");
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [kindById, setKindById] = React.useState<Map<string, "testSuite" | "process">>(new Map());

  const runScan = React.useCallback(async () => {
    setScanBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await window.ade.ci.scan();
      setScan(next);
      setSelectedIds(new Set());
      setKindById(new Map());
      if (next.providers.length === 0) {
        setNotice("No CI configs detected (GitHub Actions, GitLab CI, CircleCI, Jenkinsfile).");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanBusy(false);
    }
  }, []);

  const visibleJobs = React.useMemo(() => {
    const jobs = scan?.jobs ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((job) => {
      const text = `${job.provider} ${job.filePath} ${job.jobName} ${job.suggestedCommandLine ?? ""}`.toLowerCase();
      return text.includes(q);
    });
  }, [scan?.jobs, query]);

  const toggle = (id: string, job: CiJobCandidate, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    setKindById((prev) => {
      const next = new Map(prev);
      if (checked && !next.has(id)) {
        next.set(id, inferKind(job));
      }
      if (!checked) {
        next.delete(id);
      }
      return next;
    });
  };

  const importSelected = async () => {
    if (!scan) return;
    const selections = Array.from(selectedIds)
      .map((jobId) => ({ jobId, kind: kindById.get(jobId) ?? "testSuite" }))
      .filter((s) => s.kind === "process" || s.kind === "testSuite");

    if (selections.length === 0) return;

    setImportBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await window.ade.ci.import({ selections, mode });
      setNotice(
        `Imported ${res.importState.importedJobs.length} mapping(s). Last import: ${formatDate(res.importState.importedAt)}`
      );
      if (onImported) onImported();
      // Re-scan to show diff as clean after import.
      const next = await window.ade.ci.scan().catch(() => null);
      if (next) setScan(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <section className="rounded shadow-card bg-card/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">CI import</div>
          <div className="mt-1 text-xs text-muted-fg">
            Scan common CI configs and import selected jobs into ADE process/test definitions.
            Imported commands are executed via direct argv (no shell), so complex pipelines are flagged.
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={scanBusy} onClick={() => void runScan()}>
            <ArrowsClockwise size={16} weight="regular" className={cn(scanBusy && "animate-spin")} />
            {scanBusy ? "Scanning…" : "Scan CI"}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded bg-red-900/25 px-3 py-2 text-xs text-red-200">{error}</div>
      ) : null}
      {notice ? (
        <div className="mt-3 rounded bg-emerald-900/20 px-3 py-2 text-xs text-emerald-200">{notice}</div>
      ) : null}

      {scan ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Chip>providers: {scan.providers.length ? scan.providers.join(", ") : "none"}</Chip>
            <Chip>jobs: {scan.jobs.length}</Chip>
            <Chip>scanned: {formatDate(scan.scannedAt)}</Chip>
            {scan.lastImport ? <Chip>last import: {formatDate(scan.lastImport.importedAt)}</Chip> : <Chip>last import: never</Chip>}
            {scan.diff ? (
              <Chip>
                diff since import: +{scan.diff.added} / -{scan.diff.removed} / ~{scan.diff.changed}
              </Chip>
            ) : null}
          </div>

          <div className="rounded bg-muted/15 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <input
                className="h-8 w-[min(420px,100%)] rounded border border-border/15 bg-surface-recessed px-2 text-xs outline-none placeholder:text-muted-fg"
                placeholder="Filter jobs (name, file, command)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-muted-fg">Mode</label>
                <select
                  className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as CiImportMode)}
                >
                  <option value="import">Import (new)</option>
                  <option value="sync">Sync (update previous)</option>
                </select>
                <Button size="sm" disabled={importBusy || selectedIds.size === 0} onClick={() => void importSelected()}>
                  {importBusy ? "Importing…" : `Import ${selectedIds.size}`}
                </Button>
              </div>
            </div>
          </div>

          <div className="overflow-auto rounded shadow-card bg-card/30">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-bg">
                <tr className="border-b border-border/10">
                  <th className="px-3 py-2 font-semibold text-fg">Select</th>
                  <th className="px-3 py-2 font-semibold text-fg">Job</th>
                  <th className="px-3 py-2 font-semibold text-fg">Provider</th>
                  <th className="px-3 py-2 font-semibold text-fg">Safety</th>
                  <th className="px-3 py-2 font-semibold text-fg">Suggested command</th>
                  <th className="px-3 py-2 font-semibold text-fg">Import as</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/10">
                {visibleJobs.map((job) => {
                  const checked = selectedIds.has(job.id);
                  const hasSuggested = Boolean(job.suggestedCommandLine && job.suggestedCommand?.length);
                  return (
                    <tr key={job.id} className={cn(!hasSuggested && "opacity-70")}>
                      <td className="px-3 py-2 align-top">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!hasSuggested}
                          onChange={(e) => toggle(job.id, job, e.target.checked)}
                          title={!hasSuggested ? "No importable command detected (shell pipelines or multiline scripts)." : undefined}
                        />
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="font-semibold text-fg">{job.jobName}</div>
                        <div className="mt-0.5 font-mono text-[11px] text-muted-fg">{job.filePath}</div>
                        {job.warnings.length ? (
                          <div className="mt-1 flex items-start gap-2 text-[11px] text-muted-fg">
                            <ShieldWarning size={16} weight="regular" className="mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              {job.warnings.slice(0, 2).map((w) => (
                                <div key={w} className="truncate">
                                  {w}
                                </div>
                              ))}
                              {job.warnings.length > 2 ? <div>…({job.warnings.length - 2} more)</div> : null}
                            </div>
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 align-top text-muted-fg">{job.provider}</td>
                      <td className="px-3 py-2 align-top">
                        <span className={cn("inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]", safetyTone(job.safety))}>
                          {job.safety === "ci-only" ? <ShieldWarning size={14} weight="regular" /> : <Wrench size={14} weight="regular" />}
                          {job.safety}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-top font-mono text-[11px] text-fg">
                        {job.suggestedCommandLine ?? <span className="text-muted-fg">(none)</span>}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <select
                          className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs"
                          value={kindById.get(job.id) ?? inferKind(job)}
                          disabled={!checked}
                          onChange={(e) =>
                            setKindById((prev) => {
                              const next = new Map(prev);
                              next.set(job.id, e.target.value as "testSuite" | "process");
                              return next;
                            })
                          }
                        >
                          <option value="testSuite">Test suite</option>
                          <option value="process">Process</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded bg-muted/10 p-4 text-xs text-muted-fg">
          Run “Scan CI” to detect jobs from GitHub Actions, GitLab CI, CircleCI, or Jenkinsfile.
        </div>
      )}
    </section>
  );
}

