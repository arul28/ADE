import { WarningCircle, X } from "@phosphor-icons/react";
import { useState } from "react";
import { useAppStore } from "../../state/appStore";

const AUTO_REPAIR_CODES = new Set([
  "disk_full",
  "insufficient_headroom",
  "db_integrity",
  "migration_incomplete",
  "migration_unknown_state",
  "brain_crash_looping",
  "brain_not_installed",
  "socket_stale_no_owner",
  "unknown",
]);

export function ProjectTransitionErrorAlert() {
  const projectTransition = useAppStore((state) => state.projectTransition);
  const projectTransitionError = useAppStore(
    (state) => state.projectTransitionError,
  );
  const clearProjectTransitionError = useAppStore(
    (state) => state.clearProjectTransitionError,
  );
  const switchProjectToPath = useAppStore((state) => state.switchProjectToPath);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);

  if (projectTransition || !projectTransitionError) return null;

  const canRepair = Boolean(
    projectTransitionError.rootPath
    && projectTransitionError.code
    && AUTO_REPAIR_CODES.has(projectTransitionError.code),
  );

  const repair = async () => {
    const rootPath = projectTransitionError.rootPath;
    if (!rootPath || repairing) return;
    setRepairing(true);
    setRepairError(null);
    try {
      const report = await window.ade.recovery.repair(rootPath);
      if (report.ok) {
        await switchProjectToPath(rootPath);
      } else {
        setRepairError(report.nextAction ?? "ADE could not finish the repair.");
      }
    } catch (error) {
      setRepairError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepairing(false);
    }
  };

  return (
    <div
      className="mx-2 mt-1 flex shrink-0 items-start gap-2 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-200"
      role="alert"
    >
      <WarningCircle size={15} weight="fill" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        <div>{projectTransitionError.message}</div>
        {projectTransitionError.detail ? (
          <details className="mt-1 text-red-100/75">
            <summary className="cursor-pointer select-none">Technical details</summary>
            <div className="mt-1">{projectTransitionError.detail}</div>
          </details>
        ) : null}
        {repairError ? <div className="mt-1 text-red-100/85">{repairError}</div> : null}
        {canRepair ? (
          <button
            type="button"
            className="mt-2 rounded border border-red-200/30 bg-red-100/10 px-2 py-1 font-medium text-red-50 transition-colors hover:bg-red-100/20 disabled:cursor-wait disabled:opacity-60"
            onClick={() => void repair()}
            disabled={repairing}
          >
            {repairing ? "Repairing ADE…" : "Repair ADE"}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-current opacity-75 transition-opacity hover:opacity-100"
        onClick={clearProjectTransitionError}
        title="Dismiss project error"
        aria-label="Dismiss project error"
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  );
}
