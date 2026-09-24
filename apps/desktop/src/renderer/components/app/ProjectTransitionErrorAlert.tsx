import { FolderSimpleDashed } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { TechnicalDetailsFold } from "./errorSurfaceKit";

/**
 * Fallback banner for project open/switch failures that do not have enough
 * context for the full-viewport recovery flow.
 *
 * Registers with the app banner host in the project band; renders nothing
 * itself. Reads as one sentence with the actions parked on the right: it sits
 * above the whole app, so it must stay a single calm strip even when the
 * message runs to two lines.
 */
export function ProjectTransitionErrorAlert(): null {
  const projectTransition = useAppStore((state) => state.projectTransition);
  const projectTransitionError = useAppStore(
    (state) => state.projectTransitionError,
  );
  const clearProjectTransitionError = useAppStore(
    (state) => state.clearProjectTransitionError,
  );
  const switchProjectToPath = useAppStore((state) => state.switchProjectToPath);

  const visible = Boolean(
    !projectTransition
      && projectTransitionError
      && !(projectTransitionError.code && projectTransitionError.rootPath),
  );
  const retryRootPath = projectTransitionError?.retryRootPath ?? null;

  useAppBanner(
    visible && projectTransitionError
      ? {
          id: "project-transition-error",
          tone: "error",
          icon: <FolderSimpleDashed size={13} weight="bold" />,
          title: <span style={{ overflowWrap: "anywhere" }}>{projectTransitionError.message}</span>,
          ariaLabel: projectTransitionError.message,
          // The same fold as the full recovery surface, so the detail reads the
          // same here and comes with the Copy affordance people reach for next.
          extra: projectTransitionError.detail
            ? <TechnicalDetailsFold text={projectTransitionError.detail} />
            : undefined,
          actions: retryRootPath
            ? [{
                label: "Try again",
                variant: "primary",
                onClick: () => {
                  clearProjectTransitionError();
                  void switchProjectToPath(retryRootPath).catch(() => {});
                },
              }]
            : undefined,
          dismiss: { onDismiss: clearProjectTransitionError, title: "Dismiss project error" },
        }
      : null,
    { placement: "docked", priority: APP_BANNER_PRIORITY.project },
  );

  return null;
}
