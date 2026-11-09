import type { CloudCreateMachineResult } from "../../../shared/adeCloud";
import { Dialog } from "../ui/dialog";
import { ADE_CLOUD_NAME } from "./cloudBrand";
import { NewCloudMachineForm } from "./NewCloudMachineForm";

/**
 * The New cloud machine form (the one in Add a computer) in a dialog, for
 * the places that open it on their own: the chat's machine picker and the
 * ADE Cloud settings page. Account-level like the form, so no pin. Closing it
 * mid-create cancels the create (the form's own unmount does that).
 */
export function NewCloudMachineDialog({
  onCreated,
  onClose,
}: {
  onCreated: (result: CloudCreateMachineResult) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={`New ${ADE_CLOUD_NAME} computer`}
      description="It signs in to your ADE account on its own and joins Your computers."
      size="lg"
    >
      <NewCloudMachineForm onCreated={onCreated} />
    </Dialog>
  );
}
