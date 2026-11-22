import { useEffect, useRef } from "react";
import { APP_WILL_QUIT_EVENT } from "../../shared/appWillQuit";

/**
 * Run `save` when the window goes away: on Quit (main's `APP_WILL_QUIT_EVENT`,
 * sent before the window is destroyed) and on a page that unloads by itself
 * (`pagehide`: a closed or reloaded window). For a save that waits on a short
 * delay after typing; `save` must write synchronously to count on Quit.
 */
export function useSaveBeforeQuit(save: () => void): void {
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const run = () => saveRef.current();
    window.addEventListener("pagehide", run);
    window.addEventListener(APP_WILL_QUIT_EVENT, run);
    return () => {
      window.removeEventListener("pagehide", run);
      window.removeEventListener(APP_WILL_QUIT_EVENT, run);
    };
  }, []);
}
