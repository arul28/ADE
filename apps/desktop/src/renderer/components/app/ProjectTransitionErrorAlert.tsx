import { WarningCircle, X } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";

/**
 * Fallback banner for project open/switch failures that do not have enough
 * context for the full-viewport recovery flow.
 */
export function ProjectTransitionErrorAlert() {
  const projectTransition = useAppStore((state) => state.projectTransition);
  const projectTransitionError = useAppStore(
    (state) => state.projectTransitionError,
  );
  const clearProjectTransitionError = useAppStore(
    (state) => state.clearProjectTransitionError,
  );
  const switchProjectToPath = useAppStore((state) => state.switchProjectToPath);

  if (projectTransition || !projectTransitionError) return null;
  if (projectTransitionError.code && projectTransitionError.rootPath) return null;
  const retryRootPath = projectTransitionError.retryRootPath ?? null;

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
      </div>
      {retryRootPath ? (
        <button
          type="button"
          className="shrink-0 rounded border border-red-300/30 px-2 py-0.5 text-[11.5px] font-medium text-red-100 transition-colors hover:bg-red-400/15"
          onClick={() => {
            clearProjectTransitionError();
            void switchProjectToPath(retryRootPath).catch(() => {});
          }}
        >
          Try again
        </button>
      ) : null}
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
