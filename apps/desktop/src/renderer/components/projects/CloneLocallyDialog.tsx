import { Dialog as AppDialog } from "../ui/dialog/Dialog";
import { CloneProjectForm } from "./CloneProjectForm";

export type CloneLocallyTarget = {
  displayName: string;
  /** The machine the project runs on now. */
  machineName: string;
  gitOriginUrl: string;
  /** The binding key of the project's tab on the other machine. */
  remoteKey: string;
};

/**
 * Clones a project that runs only on another machine onto this one. The form
 * starts with the project's git origin filled in; the user picks the folder.
 */
export function CloneLocallyDialog({
  target,
  onClose,
  onCloned,
}: {
  target: CloneLocallyTarget | null;
  onClose: () => void;
  onCloned: (result: { rootPath: string; displayName: string }) => void;
}) {
  return (
    <AppDialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={target ? `Clone ${target.displayName} to this machine` : "Clone to this machine"}
      description={
        target
          ? `${target.displayName} runs on ${target.machineName}. A local copy lets you work on it here too.`
          : undefined
      }
      size="lg"
      tone="accent"
      stopClickPropagation
    >
      {target ? (
        <CloneProjectForm
          key={target.gitOriginUrl}
          initialUrl={target.gitOriginUrl}
          onCancel={onClose}
          onCloned={(result) => {
            onClose();
            onCloned(result);
          }}
        />
      ) : null}
    </AppDialog>
  );
}
