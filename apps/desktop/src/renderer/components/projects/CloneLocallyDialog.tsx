import { THIS_MACHINE_ID } from "../../../shared/machineIdentity";
import { Dialog as AppDialog } from "../ui/dialog/Dialog";
import { AddProjectForm } from "./AddProjectForm";
import type { CopyOpenTarget } from "./projectCopies";

export type CloneLocallyTarget = {
  displayName: string;
  /** The machine the project runs on now. */
  machineName: string;
  gitOriginUrl: string;
  /** The binding key of the project's tab on the other machine. */
  remoteKey: string;
};

const LOCAL_ONLY: readonly string[] = [THIS_MACHINE_ID];

/**
 * Adds a copy of a project that is on another machine. The Add project form
 * starts with the project's git origin filled in and this computer ticked;
 * the other machines are there too, each with its own state.
 */
export function CloneLocallyDialog({
  target,
  onClose,
  onOpenProject,
}: {
  target: CloneLocallyTarget | null;
  onClose: () => void;
  onOpenProject: (target: CopyOpenTarget) => Promise<void>;
}) {
  return (
    <AppDialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={target ? `Add a copy of ${target.displayName}` : "Add a copy"}
      description={
        target
          ? `${target.displayName} is on ${target.machineName}. A copy on this computer lets you work on it here too.`
          : undefined
      }
      size="lg"
      tone="accent"
      stopClickPropagation
    >
      {target ? (
        <AddProjectForm
          key={target.gitOriginUrl}
          initialUrl={target.gitOriginUrl}
          initialMachineIds={LOCAL_ONLY}
          onCancel={onClose}
          onClose={onClose}
          onOpenProject={onOpenProject}
        />
      ) : null}
    </AppDialog>
  );
}
