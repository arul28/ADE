import { WarningCircle, X } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { TechnicalDetailsFold } from "./errorSurfaceKit";

/**
 * Fallback banner for project open/switch failures that do not have enough
 * context for the full-viewport recovery flow.
 *
 * Reads as one sentence with the actions parked on the right: this sits above
 * the whole app, so it must stay a single calm strip even when the message
 * runs to two lines.
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
      className="mx-2 mt-1 flex shrink-0 items-start gap-2.5 rounded-md border border-amber-400/25 bg-amber-400/[0.08] px-3 py-2 text-[12px] leading-relaxed text-amber-100/90"
      role="alert"
    >
      <WarningCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-amber-300" />
      <div className="min-w-0 flex-1">
        <div className="break-words">{projectTransitionError.message}</div>
        {projectTransitionError.detail ? (
          // The same fold as the full recovery surface, so the detail reads the
          // same here and comes with the Copy affordance people reach for next.
          <TechnicalDetailsFold text={projectTransitionError.detail} className="mt-1.5" />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {retryRootPath ? (
          <button
            type="button"
            className="rounded border border-amber-300/30 bg-amber-300/[0.08] px-2 py-0.5 text-[11.5px] font-medium text-amber-100 transition-colors hover:bg-amber-300/20"
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
          className="inline-flex h-5 w-5 items-center justify-center rounded text-current opacity-60 transition-opacity hover:opacity-100"
          onClick={clearProjectTransitionError}
          title="Dismiss project error"
          aria-label="Dismiss project error"
        >
          <X size={12} weight="bold" />
        </button>
      </div>
    </div>
  );
}
