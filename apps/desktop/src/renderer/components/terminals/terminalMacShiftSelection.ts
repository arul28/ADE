export type MacShiftSelectionBridgeArgs = {
  host: HTMLElement;
  isDisposed: () => boolean;
  isMouseTrackingActive: () => boolean;
  platform?: string;
};

export function installMacShiftSelectionBridge({
  host,
  isDisposed,
  isMouseTrackingActive,
  platform = navigator.platform,
}: MacShiftSelectionBridgeArgs): () => void {
  if (!platform.toLowerCase().includes("mac")) return () => {};

  const onMouseDown = (event: MouseEvent) => {
    if (isDisposed() || !isMouseTrackingActive()) return;
    if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof EventTarget)) return;

    // xterm forces selection with Shift on other platforms, but on macOS it
    // only recognizes Option when macOptionClickForcesSelection is enabled.
    // Translate the initial gesture so remote/full-screen CLI mouse tracking
    // does not make terminal text impossible to select and copy.
    event.preventDefault();
    event.stopImmediatePropagation();
    target.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      composed: event.composed,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      altKey: true,
      button: event.button,
      buttons: event.buttons,
      relatedTarget: event.relatedTarget,
    }));
  };

  host.addEventListener("mousedown", onMouseDown, true);
  return () => host.removeEventListener("mousedown", onMouseDown, true);
}
