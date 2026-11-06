import type { Agent37CreateMachineResult, Agent37Status } from "../../../shared/agent37";
import { Dialog } from "../ui/dialog";
import { AGENT37_NAME } from "./agent37Brand";
import { NewAgent37MachineForm } from "./NewAgent37MachineForm";

/**
 * The New Agent 37 machine form (the one in Add a computer) in a dialog, for
 * the places that open it on their own: the chat's machine picker and the
 * Agent 37 settings page. Account-level like the form, so no pin. Closing it
 * mid-create cancels the create (the form's own unmount does that).
 */
export function NewAgent37MachineDialog({
  status,
  onCreated,
  onClose,
}: {
  status: Agent37Status;
  onCreated: (result: Agent37CreateMachineResult) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={`New ${AGENT37_NAME} machine`}
      description="It signs in to your ADE account on its own and joins Your computers."
      size="lg"
    >
      <NewAgent37MachineForm status={status} onCreated={onCreated} />
    </Dialog>
  );
}
