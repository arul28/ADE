import { useEffect } from "react";
import { dialogBus, type DialogBusEvent } from "./dialogBus";

export type UseDialogBusHandlers = {
  onOpen?: (props?: Record<string, unknown>) => void;
  onClose?: () => void;
};

// Subscribe a dialog-hosting page to the tour dialogBus. Tour steps dispatch
// `dialogBus.open("lanes.create")` etc; the page that owns the dialog state
// listens with this hook and flips its local open flag.
export function useDialogBus(id: string, handlers: UseDialogBusHandlers): void {
  const { onOpen, onClose } = handlers;
  useEffect(() => {
    const unsubscribe = dialogBus.subscribe(id, (event: DialogBusEvent) => {
      if (event.type === "open") {
        onOpen?.(event.props);
      } else {
        onClose?.();
      }
    });
    return unsubscribe;
  }, [id, onOpen, onClose]);
}
