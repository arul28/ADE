import { WarningCircle, X } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";

export function ProjectTransitionErrorAlert() {
  const projectTransition = useAppStore((state) => state.projectTransition);
  const projectTransitionError = useAppStore(
    (state) => state.projectTransitionError,
  );
  const clearProjectTransitionError = useAppStore(
    (state) => state.clearProjectTransitionError,
  );

  if (projectTransition || !projectTransitionError) return null;

  return (
    <div
      className="mx-2 mt-1 flex shrink-0 items-start gap-2 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-200"
      role="alert"
    >
      <WarningCircle size={15} weight="fill" className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {projectTransitionError}
      </span>
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
