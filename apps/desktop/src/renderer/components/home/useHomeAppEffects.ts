import { useEffect } from "react";
import {
  HOME_LAYOUTS_STORAGE_KEY,
  reloadHomeLayoutsFromStorage,
  useHomeLayoutStore,
  type HomeLayoutItem,
} from "./homeLayout";

/**
 * The home page's app-wide rules, mounted once by `App` (they hold whether
 * or not the home page is showing).
 *
 * - Layouts follow another window's saves (`storage` event), so a second
 *   window does not write an old copy back over them.
 * - The clipboard watch in main runs only while a Clipboard widget is in the
 *   active layout. Removing it, a reset or switching to a layout without one
 *   stops the watch; so does finding none a few seconds after launch, which
 *   covers a layout lost outside the store (cleared storage, another
 *   profile). Each window's grid also tells main whether it shows the widget
 *   or hides it for lack of room (`HomeWidgetGrid`): main pauses the watch
 *   while some window hides it and none shows it.
 */
export function useHomeAppEffects(): void {
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === HOME_LAYOUTS_STORAGE_KEY) reloadHomeLayoutsFromStorage();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    let had = hasClipboard(useHomeLayoutStore.getState().layout.items);
    const unsubscribe = useHomeLayoutStore.subscribe((state) => {
      const has = hasClipboard(state.layout.items);
      if (had && !has) stopClipboardWatch();
      had = has;
    });
    const timer = had ? null : window.setTimeout(() => {
      if (!hasClipboard(useHomeLayoutStore.getState().layout.items)) stopClipboardWatch();
    }, 6_000);
    return () => {
      unsubscribe();
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);
}

function hasClipboard(items: readonly HomeLayoutItem[]): boolean {
  return items.some((item) => item.type === "clipboard");
}

/** Turns the main-process clipboard watch off, if it is on. One small IPC. */
export function stopClipboardWatch(): void {
  const bridge = window.ade?.home?.clipboard;
  if (!bridge) return;
  void bridge.getState()
    .then((state) => (state.enabled ? bridge.configure({ enabled: false }) : null))
    .catch(() => {});
}
