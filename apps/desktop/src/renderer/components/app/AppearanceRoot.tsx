import { useEffect, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { applyInterfacePreferences } from "../../theme/applyInterface";
import { useAppStore } from "../../state/appStore";
import { ThemeDocumentSync } from "./ThemeDocumentSync";

/**
 * The appearance every shell shares: interface preferences on <html>, the
 * theme and scene (`ThemeDocumentSync`), the reduce-motion setting, and the OS
 * colour scheme that "System" follows. The app shell and the hosted client's
 * sign-in screen both mount it, so a signed-out visitor sees the same look.
 */
export function AppearanceRoot({ children }: { children: ReactNode }) {
  const setSystemColorScheme = useAppStore((s) => s.setSystemColorScheme);
  const interfacePreferences = useAppStore((s) => s.interfacePreferences);

  useEffect(() => {
    applyInterfacePreferences(interfacePreferences);
  }, [interfacePreferences]);

  // Track the OS colour scheme on the root store. The painted theme follows it
  // only when the user chose "System"; the listener itself is always cheap.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => setSystemColorScheme(query.matches ? "light" : "dark");
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [setSystemColorScheme]);

  // The interface "Reduce motion" preference is explicit, so it wins over the
  // OS query; off, `"user"` is exactly the OS-honouring default.
  return (
    <MotionConfig reducedMotion={interfacePreferences.reduceMotion ? "always" : "user"}>
      <ThemeDocumentSync />
      {children}
    </MotionConfig>
  );
}
