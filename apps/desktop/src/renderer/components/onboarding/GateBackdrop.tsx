import { useAppStore } from "../../state/appStore";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";

/**
 * ADE's mesh, drawn as one window-sized field behind the glass card, with a
 * vignette that keeps the card's edges legible. Follows the theme and any
 * image scene on its own.
 */
export function GateBackdrop() {
  const theme = useAppStore((s) => s.theme);
  return (
    <>
      <WorkToolPickerBackdrop theme={theme} field="window" />
      <div className="ade-gate-vignette" aria-hidden="true" />
    </>
  );
}
