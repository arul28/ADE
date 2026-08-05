import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "framer-motion";
import { INSTALL_TARGETS, type InstallPlatform } from "../../lib/installTargets";
import { captureMarketingFeature } from "../../lib/marketingAnalyticsBrowser";
import { InstallDialog } from "./InstallDialog";

type InstallDialogApi = {
  openInstall: (platform: InstallPlatform) => void;
  closeInstall: () => void;
  openPlatform: InstallPlatform | null;
};

const InstallDialogContext = createContext<InstallDialogApi | null>(null);

/**
 * Owns the single install dialog instance for the whole site. Every
 * "Download for Mac"/"Download for Windows" CTA — hero, back cover, header,
 * footer — calls openInstall() instead of linking straight at GitHub.
 */
export function InstallDialogProvider({ children }: { children: ReactNode }) {
  const [openPlatform, setOpenPlatform] = useState<InstallPlatform | null>(null);

  const openInstall = useCallback((platform: InstallPlatform) => {
    setOpenPlatform(platform);
    // Captured here rather than on each trigger so the open event is identical
    // wherever it came from; triggers keep their own cta_label/position.
    captureMarketingFeature(INSTALL_TARGETS[platform].openAnalyticsFeature);
  }, []);

  const closeInstall = useCallback(() => setOpenPlatform(null), []);

  const api = useMemo<InstallDialogApi>(
    () => ({ openInstall, closeInstall, openPlatform }),
    [openInstall, closeInstall, openPlatform],
  );

  return (
    <InstallDialogContext.Provider value={api}>
      {children}
      {typeof document === "undefined"
        ? null
        : createPortal(
            <AnimatePresence>
              {openPlatform ? (
                <InstallDialog
                  key={openPlatform}
                  target={INSTALL_TARGETS[openPlatform]}
                  onClose={closeInstall}
                />
              ) : null}
            </AnimatePresence>,
            document.body,
          )}
    </InstallDialogContext.Provider>
  );
}

export function useInstallDialog(): InstallDialogApi {
  const api = useContext(InstallDialogContext);
  if (!api) throw new Error("useInstallDialog must be used inside <InstallDialogProvider>");
  return api;
}
