import React from "react";
import { ArrowSquareOut, CaretUpDown, CheckCircle, GlobeHemisphereWest, SignOut } from "@phosphor-icons/react";

import type { MusicAccount } from "../../../shared/types/music";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_SEPARATOR_CLASS, MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { musicActions } from "./musicStore";

type Account = MusicAccount;

/** Region names for storefront codes when Apple's answer has no name. */
function regionName(id: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(id.toUpperCase()) ?? id.toUpperCase();
  } catch {
    return id.toUpperCase();
  }
}

function useAccount(): Account | null {
  const [account, setAccount] = React.useState<Account | null>(null);
  React.useEffect(() => {
    const bridge = window.ade?.music;
    if (!bridge) return undefined;
    let live = true;
    bridge.account().then(
      (value) => {
        if (live) setAccount(value);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return account;
}

/**
 * The rail's account area while Apple Music is connected: who is connected and
 * where (the storefront decides what the catalog offers), with Disconnect in a
 * menu rather than one stray click away. Apple's API does not say whether the
 * subscription is active, so the menu doesn't claim it.
 */
export function MusicAccountArea() {
  const account = useAccount();
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLButtonElement>(null);
  const region = account?.storefront ? (account.storefront.name ?? regionName(account.storefront.id)) : null;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="ade-music-account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="music-account"
      >
        <span className="ade-music-account-avatar" aria-hidden>
          <CheckCircle size={16} weight="fill" />
        </span>
        <span className="ade-music-account-text">
          <span className="ade-music-account-title">Apple Music</span>
          <span className="ade-music-account-sub">{region ? `Connected · ${region}` : "Connected"}</span>
        </span>
        <CaretUpDown size={13} className="ade-music-account-caret" />
      </button>
      <AnchoredMenu open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} placement="top-start" matchAnchorWidth>
        <div className={cn(MENU_SURFACE_CLASS, "py-1")} role="menu">
          <div className={MENU_LABEL_CLASS}>Apple Music account</div>
          {region ? (
            <div className={cn(MENU_ITEM_CLASS, "pointer-events-none")}>
              <GlobeHemisphereWest size={14} />
              <span className="min-w-0 flex-1 truncate">Store: {region}</span>
            </div>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={cn(MENU_ITEM_CLASS, "w-full hover:bg-fg/[0.07] hover:text-fg")}
            onClick={() => {
              setOpen(false);
              window.open("https://music.apple.com/account/settings", "_blank", "noopener,noreferrer");
            }}
          >
            <ArrowSquareOut size={14} />
            <span className="min-w-0 flex-1 truncate text-left">Manage subscription</span>
          </button>
          <div className={MENU_SEPARATOR_CLASS} />
          <button
            type="button"
            role="menuitem"
            className={cn(MENU_ITEM_CLASS, "w-full text-error hover:bg-error/10")}
            onClick={() => {
              setOpen(false);
              void musicActions.disconnect();
            }}
          >
            <SignOut size={14} />
            <span className="min-w-0 flex-1 truncate text-left">Disconnect Apple Music</span>
          </button>
        </div>
      </AnchoredMenu>
    </>
  );
}
