import { useState, type CSSProperties, type ReactNode } from "react";
import { AppWindow, ArrowSquareOut } from "@phosphor-icons/react";

import type { InstalledBrowser } from "../../../shared/browserTargets";
import type { OpenProjectBinding } from "../../../shared/types/core";
import {
  canOpenInAdeBrowser,
  canOpenUrlOnThisMachine,
  normalizeBrowserUrlInput,
  openExternalUrl,
  openUrlInAdeBrowser,
} from "../../lib/openExternal";
import { BrowserTargetLogo } from "./BrowserTargetLogo";
import {
  MENU_ITEM_CLASS,
  MenuRowIcon,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuStatus,
} from "./MenuSubmenu";
import { useInstalledTargets } from "./useInstalledTargets";

/**
 * "Open this link in ▸" — ADE's own browser, the system default, and every
 * browser installed on this machine, each under its real app icon.
 *
 * The installed list comes from the main process, which reads the app icons off
 * the machine itself. Detection is desktop-only: on the hosted web client the
 * bridge method is absent, so the panel falls back to the two choices that
 * still mean something there.
 *
 * Mirrors `OpenInSubmenu`'s props for parity with the other "Open in ▸" row;
 * like it, the host supplies the styling and this component supplies the rows.
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
  const { items: browsers, error: detectionError } = useInstalledTargets<InstalledBrowser>(
    window.ade?.app?.getInstalledBrowsers,
  );
  // A row that failed to launch is its own message — pointing it at a different
  // browser than the one clicked would be a silent substitution.
  const [openError, setOpenError] = useState<string | null>(null);
  // A `localhost` link belongs to the machine the chat runs on; only ADE's
  // browser can reach it. Rendered markdown also keeps hrefs no browser can
  // take (`irc:`, protocol-relative), where a row's only outcome is an
  // allowlist error. Both cases leave the external rows off.
  const external = canOpenUrlOnThisMachine(url, { runtimePin: runtimePin ?? null });
  const ade = canOpenInAdeBrowser(url);
  // The gate above normalizes; `openExternalUrl` does not. Hand it the same
  // completed URL so a link that passed the gate cannot fail on the way out.
  const openUrl = normalizeBrowserUrlInput(url) ?? url;

  const openExternal = () => {
    openExternalUrl(openUrl);
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
      openExternalUrl(openUrl);
      onClose();
      return;
    }
    try {
      await opener({ url: openUrl, browserId: browser.id });
      onClose();
    } catch (reason) {
      setOpenError(reason instanceof Error ? reason.message : String(reason));
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
      {ade ? (
        <button type="button" role="menuitem" className={MENU_ITEM_CLASS} onClick={openInAde}>
          <MenuRowIcon icon={AppWindow} />
          ADE Browser
        </button>
      ) : null}
      {external ? (
        <button type="button" role="menuitem" className={MENU_ITEM_CLASS} onClick={openExternal}>
          <MenuRowIcon icon={ArrowSquareOut} />
          System Browser
        </button>
      ) : null}
      {!external ? null : browsers === null ? (
        <MenuSubmenuStatus>Detecting browsers…</MenuSubmenuStatus>
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
      {detectionError || openError ? (
        <MenuSubmenuStatus tone="danger">{detectionError ?? openError}</MenuSubmenuStatus>
      ) : null}
    </MenuSubmenu>
  );
}
