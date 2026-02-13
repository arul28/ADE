import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type {
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ExportConfigBundleResult,
  HostedMirrorDeleteResult,
  HostedStatus
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

const CHECKBOX_CLASS =
  "h-4 w-4 rounded border border-border bg-bg align-middle accent-[var(--color-accent)]";

function prettyList(paths: string[]): string {
  return paths.length ? paths.join("\n") : "(nothing deleted)";
}

export function DataManagementSection() {
  const [hostedStatus, setHostedStatus] = React.useState<HostedStatus | null>(null);
  const [hostedError, setHostedError] = React.useState<string | null>(null);

  const [clearOpen, setClearOpen] = React.useState(false);
  const [clearBusy, setClearBusy] = React.useState(false);
  const [clearError, setClearError] = React.useState<string | null>(null);
  const [clearResult, setClearResult] = React.useState<ClearLocalAdeDataResult | null>(null);
  const [clearArgs, setClearArgs] = React.useState<Required<ClearLocalAdeDataArgs>>({
    packs: true,
    logs: true,
    transcripts: true
  });
  const [clearConfirm, setClearConfirm] = React.useState("");

  const [exportBusy, setExportBusy] = React.useState(false);
  const [exportError, setExportError] = React.useState<string | null>(null);
  const [exportResult, setExportResult] = React.useState<ExportConfigBundleResult | null>(null);

  const [mirrorOpen, setMirrorOpen] = React.useState(false);
  const [mirrorBusy, setMirrorBusy] = React.useState(false);
  const [mirrorError, setMirrorError] = React.useState<string | null>(null);
  const [mirrorResult, setMirrorResult] = React.useState<HostedMirrorDeleteResult | null>(null);
  const [mirrorConfirm, setMirrorConfirm] = React.useState("");

  const refreshHostedStatus = React.useCallback(async () => {
    try {
      setHostedError(null);
      const status = await window.ade.hosted.getStatus();
      setHostedStatus(status);
    } catch (err) {
      setHostedError(err instanceof Error ? err.message : String(err));
      setHostedStatus(null);
    }
  }, []);

  React.useEffect(() => {
    void refreshHostedStatus();
  }, [refreshHostedStatus]);

  const runClear = async () => {
    const selected = Object.entries(clearArgs).filter(([, enabled]) => enabled);
    if (selected.length === 0) {
      setClearError("Select at least one category to clear.");
      return;
    }
    if (clearConfirm.trim().toUpperCase() !== "CLEAR") {
      setClearError('Type "CLEAR" to confirm.');
      return;
    }

    setClearBusy(true);
    setClearError(null);
    setClearResult(null);
    try {
      const result = await window.ade.project.clearLocalData(clearArgs);
      setClearResult(result);
      setClearOpen(false);
      setClearConfirm("");
    } catch (err) {
      setClearError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearBusy(false);
    }
  };

  const runExport = async () => {
    setExportBusy(true);
    setExportError(null);
    setExportResult(null);
    try {
      const result = await window.ade.project.exportConfig();
      setExportResult(result);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportBusy(false);
    }
  };

  const runDeleteMirror = async () => {
    if (mirrorConfirm.trim().toUpperCase() !== "DELETE") {
      setMirrorError('Type "DELETE" to confirm.');
      return;
    }

    setMirrorBusy(true);
    setMirrorError(null);
    setMirrorResult(null);
    try {
      const result = await window.ade.hosted.deleteMirrorData();
      setMirrorResult(result);
      setMirrorOpen(false);
      setMirrorConfirm("");
      await refreshHostedStatus();
    } catch (err) {
      setMirrorError(err instanceof Error ? err.message : String(err));
    } finally {
      setMirrorBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted-fg">Data Management</div>
          <div className="mt-1 text-sm font-semibold text-fg">Export, reset caches, and manage hosted mirrors</div>
          <div className="mt-1 text-xs text-muted-fg">
            These actions do not modify your git history. Some actions are irreversible and require typed confirmation.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void runExport()} disabled={exportBusy}>
            {exportBusy ? "Exporting..." : "Export config"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setClearOpen(true)}>
            Clear local data...
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-700/60 text-red-200 hover:bg-red-900/20"
            onClick={() => setMirrorOpen(true)}
            disabled={!hostedStatus?.remoteProjectId}
            title={hostedStatus?.remoteProjectId ? "Delete hosted mirror data" : "No hosted mirror is configured for this repo."}
          >
            Delete mirror...
          </Button>
        </div>
      </div>

      {exportError ? (
        <div className="mt-3 rounded border border-red-900 bg-red-950/20 p-2 text-xs text-red-300">{exportError}</div>
      ) : null}
      {exportResult && !exportResult.cancelled ? (
        <div className="mt-3 rounded border border-border bg-bg/40 p-2 text-xs">
          <div className="text-fg">Exported config bundle</div>
          <div className="mt-1 text-muted-fg">path: {exportResult.savedPath}</div>
          <div className="mt-1 text-muted-fg">
            bytes: {exportResult.bytesWritten} · at: {exportResult.exportedAt}
          </div>
          <div className="mt-1 text-[11px] text-muted-fg">Includes `ade.yaml` and a redacted `local.yaml` in JSON form.</div>
        </div>
      ) : exportResult && exportResult.cancelled ? (
        <div className="mt-3 rounded border border-border bg-bg/40 p-2 text-xs text-muted-fg">Export cancelled.</div>
      ) : null}

      <div className="mt-3 rounded border border-border bg-bg/30 p-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="text-muted-fg">Hosted mirror</div>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void refreshHostedStatus()}>
            Refresh
          </Button>
        </div>
        {hostedError ? <div className="mt-2 text-red-200">{hostedError}</div> : null}
        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-fg">enabled</div>
            <div className="text-fg">{hostedStatus?.enabled ? "yes" : "no"}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-fg">remoteProjectId</div>
            <div className="text-fg">{hostedStatus?.remoteProjectId ?? "(none)"}</div>
          </div>
        </div>
      </div>

      {clearResult ? (
        <div className="mt-3 rounded border border-border bg-bg/40 p-2 text-xs">
          <div className="text-fg">Cleared local data</div>
          <div className="mt-1 text-muted-fg">at: {clearResult.clearedAt}</div>
          <pre className="mt-2 max-h-28 overflow-auto rounded border border-border bg-bg/60 p-2 text-[10px] text-fg whitespace-pre-wrap">
            {prettyList(clearResult.deletedPaths)}
          </pre>
        </div>
      ) : null}

      {mirrorResult ? (
        <div className="mt-3 rounded border border-border bg-bg/40 p-2 text-xs">
          <div className="text-fg">Hosted mirror deleted</div>
          <div className="mt-1 text-muted-fg">remoteProjectId: {mirrorResult.remoteProjectId}</div>
          <div className="mt-1 text-muted-fg">at: {mirrorResult.deletedAt}</div>
        </div>
      ) : null}

      <Dialog.Root open={clearOpen} onOpenChange={(open) => { setClearOpen(open); setClearError(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[10%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded-sm border border-border bg-bg p-4 shadow-2xl focus:outline-none">
            <div className="mb-2 flex items-center justify-between">
              <Dialog.Title className="text-sm font-semibold text-fg">Clear local ADE data</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm" disabled={clearBusy}>
                  Close
                </Button>
              </Dialog.Close>
            </div>

            <div className="rounded border border-amber-700/60 bg-amber-900/20 p-2 text-xs text-amber-200">
              This deletes selected directories under `.ade/`. It can remove pack narratives and transcript history.
            </div>

            <div className="mt-3 space-y-2 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className={CHECKBOX_CLASS}
                  checked={clearArgs.packs}
                  onChange={(e) => setClearArgs((prev) => ({ ...prev, packs: e.target.checked }))}
                />
                <span className="text-fg">Packs (`.ade/packs/`)</span>
                <span className="ml-auto text-muted-fg">context + conflict packs</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className={CHECKBOX_CLASS}
                  checked={clearArgs.transcripts}
                  onChange={(e) => setClearArgs((prev) => ({ ...prev, transcripts: e.target.checked }))}
                />
                <span className="text-fg">Transcripts (`.ade/transcripts/`)</span>
                <span className="ml-auto text-muted-fg">terminal logs</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className={CHECKBOX_CLASS}
                  checked={clearArgs.logs}
                  onChange={(e) => setClearArgs((prev) => ({ ...prev, logs: e.target.checked }))}
                />
                <span className="text-fg">Logs (`.ade/logs/`)</span>
                <span className="ml-auto text-muted-fg">app logs</span>
              </label>
            </div>

            <div className="mt-3 rounded border border-border bg-bg/40 p-2 text-xs">
              <div className="text-muted-fg">Type <span className="text-fg font-semibold">CLEAR</span> to confirm.</div>
              <input
                value={clearConfirm}
                onChange={(e) => setClearConfirm(e.target.value)}
                className="mt-2 h-8 w-full rounded border border-border bg-bg px-2 text-xs outline-none focus:border-accent"
                placeholder="CLEAR"
                disabled={clearBusy}
              />
            </div>

            {clearError ? (
              <div className="mt-3 rounded border border-red-900 bg-red-950/20 p-2 text-xs text-red-300">{clearError}</div>
            ) : null}

            <div className="mt-3 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setClearOpen(false)} disabled={clearBusy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                className={cn("border-red-700/60 text-red-200 hover:bg-red-900/20", "bg-red-950/20")}
                disabled={clearBusy}
                onClick={() => void runClear()}
              >
                {clearBusy ? "Clearing..." : "Clear"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={mirrorOpen} onOpenChange={(open) => { setMirrorOpen(open); setMirrorError(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[10%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded-sm border border-border bg-bg p-4 shadow-2xl focus:outline-none">
            <div className="mb-2 flex items-center justify-between">
              <Dialog.Title className="text-sm font-semibold text-fg">Delete hosted mirror data</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm" disabled={mirrorBusy}>
                  Close
                </Button>
              </Dialog.Close>
            </div>

            <div className="rounded border border-red-700/60 bg-red-900/20 p-2 text-xs text-red-200">
              This deletes the remote hosted mirror for this repo. It cannot be undone.
            </div>

            <div className="mt-3 rounded border border-border bg-bg/40 p-2 text-xs">
              <div className="text-muted-fg">Current remoteProjectId</div>
              <div className="mt-1 text-fg">{hostedStatus?.remoteProjectId ?? "(none)"}</div>
            </div>

            <div className="mt-3 rounded border border-border bg-bg/40 p-2 text-xs">
              <div className="text-muted-fg">Type <span className="text-fg font-semibold">DELETE</span> to confirm.</div>
              <input
                value={mirrorConfirm}
                onChange={(e) => setMirrorConfirm(e.target.value)}
                className="mt-2 h-8 w-full rounded border border-border bg-bg px-2 text-xs outline-none focus:border-accent"
                placeholder="DELETE"
                disabled={mirrorBusy}
              />
            </div>

            {mirrorError ? (
              <div className="mt-3 rounded border border-red-900 bg-red-950/20 p-2 text-xs text-red-300">{mirrorError}</div>
            ) : null}

            <div className="mt-3 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setMirrorOpen(false)} disabled={mirrorBusy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                className={cn("border-red-700/60 text-red-200 hover:bg-red-900/20", "bg-red-950/20")}
                disabled={mirrorBusy}
                onClick={() => void runDeleteMirror()}
              >
                {mirrorBusy ? "Deleting..." : "Delete mirror"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

