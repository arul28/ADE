import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { AppWindow, ArrowSquareOut } from "@phosphor-icons/react";

import type { InstalledBrowser } from "../../../shared/browserTargets";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { canOpenInAdeBrowser, openExternalUrl, openUrlInAdeBrowser } from "../../lib/openExternal";
import { BrowserTargetLogo } from "./BrowserTargetLogo";
import { MENU_ITEM_CLASS, MenuRowIcon, MenuSeparator, MenuSubmenu } from "./MenuSubmenu";

/**
 * "Open this link in ▸" — ADE's own browser, the system default, and every
 * browser installed on this machine, each under its real app icon.
 *
 * The installed list comes from the main process, which reads the app icons off
 * the machine itself. Detection is desktop-only: on the hosted web client the
 * bridge method is absent and the panel falls back to the two choices that
 * still mean something there.
 */
export function OpenLinkInSubmenu({
  url,
  runtimePin,
  onClose,
  className = MENU_ITEM_CLASS,
  style,
  hoverBackground,
  label = "Open in",
  icon,
}: {
  url: string;
  runtimePin?: OpenProjectBinding | null;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
  hoverBackground?: string;
  label?: string;
  icon?: ReactNode;
}) {
  // null while detecting, so an empty list and a pending one read differently.
  const [browsers, setBrowsers] = useState<InstalledBrowser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const detector = window.ade?.app?.getInstalledBrowsers;
    if (typeof detector !== "function") {
      setBrowsers([]);
      return;
    }
    void detector()
      .then((found) => {
        if (!cancelled) setBrowsers(found);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setBrowsers([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openExternal = () => {
    openExternalUrl(url);
    onClose();
  };

  const openInAde = () => {
    openUrlInAdeBrowser(url, { runtimePin: runtimePin ?? null });
    onClose();
  };

  const openInBrowser = async (browser: InstalledBrowser) => {
    const opener = window.ade?.app?.openInBrowser;
    if (typeof opener !== "function") {
      // No OS browser bridge (hosted web): the system default is the honest
      // equivalent of "some other browser".
      openExternalUrl(url);
      onClose();
      return;
    }
    try {
      await opener({ url, browserId: browser.id });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <MenuSubmenu
      label={label}
      icon={
        icon ?? (
          <span aria-hidden data-menu-icon="" className="inline-flex shrink-0 text-fg/45">
            <AppWindow size={13} weight="duotone" />
          </span>
        )
      }
      className={className}
      style={style}
      hoverBackground={hoverBackground}
      title="Open this link in a browser"
      panelStyle={{ padding: "4px 0" }}
      panelMinWidth={230}
    >
      {canOpenInAdeBrowser(url) ? (
        <button type="button" role="menuitem" className={MENU_ITEM_CLASS} onClick={openInAde}>
          <MenuRowIcon icon={AppWindow} />
          ADE Browser
        </button>
      ) : null}
      <button type="button" role="menuitem" className={MENU_ITEM_CLASS} onClick={openExternal}>
        <MenuRowIcon icon={ArrowSquareOut} />
        System Browser
      </button>
      {browsers === null ? (
        <div className="px-3 py-2 text-[11px] text-muted-fg/55">Detecting browsers…</div>
      ) : browsers.length > 0 ? (
        <>
          <MenuSeparator />
          {browsers.map((browser) => (
            <button
              key={browser.id}
              type="button"
              role="menuitem"
              className={MENU_ITEM_CLASS}
              onClick={() => void openInBrowser(browser)}
            >
              <BrowserTargetLogo browserId={browser.id} iconDataUrl={browser.iconDataUrl} />
              {browser.label}
            </button>
          ))}
        </>
      ) : null}
      {error ? (
        <div className="px-3 py-2 text-[11px] text-rose-300" role="alert">
          {error}
        </div>
      ) : null}
    </MenuSubmenu>
  );
}
