import { useEffect, useState } from "react";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";

/**
 * "Ask before quitting": the way back from the quit prompt's "Don't ask
 * again". Machine-local, like the prompt itself. The warning shown when
 * quitting would stop running agents is never silenced, so the hint says so.
 */
export function QuitConfirmationSection() {
  const [ask, setAsk] = useState(true);
  const api = window.ade?.app;

  useEffect(() => {
    let cancelled = false;
    void api?.getAskBeforeQuit?.()
      .then((value) => {
        if (!cancelled) setAsk(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!api?.setAskBeforeQuit) return null;

  const change = (next: boolean) => {
    setAsk(next);
    void api.setAskBeforeQuit?.(next)
      .then(setAsk)
      .catch(() => setAsk(!next));
  };

  return (
    <ModernSection group="Quitting" anchor="quit-confirmation" title="Quitting ADE">
      <ModernRows>
        <ModernRow
          title="Ask before quitting"
          hint="Agents keep running in the background after you quit. ADE always warns you when quitting would stop them."
          control={<SettingsToggle checked={ask} onChange={change} label="Ask before quitting" />}
        />
      </ModernRows>
    </ModernSection>
  );
}
