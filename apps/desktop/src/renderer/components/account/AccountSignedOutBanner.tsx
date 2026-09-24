import { useCallback } from "react";
import { ShieldWarning, UserCircle } from "@phosphor-icons/react";
import { useLocation, type NavigateFunction } from "react-router-dom";
import { accountSessionBanner, accountSessionState, useAccountStatus } from "../../lib/account";
import { describeThisComputerRefusal } from "../../lib/thisComputerRefusal";
import { useReconnectThisComputer } from "../../hooks/useReconnectThisComputer";
import { useThisComputerRefusal } from "../../hooks/useThisComputerRefusal";
import { APP_BANNER_PRIORITY, useAppBanner, type BannerModel } from "../ui/notice";

const ACCOUNT_ICON = <UserCircle size={13} weight="fill" />;
const REFUSED_ICON = <ShieldWarning size={13} weight="fill" />;

/**
 * The permanent bar ADE shows while the account is not usable.
 *
 * ADE requires an account, so a machine with no usable session is in a state
 * the user must resolve. But local work must never be blocked, so this is a bar
 * and not a wall. It is deliberately **not** dismissable: `bannerDismiss.ts`
 * exists for banners that a user can reasonably decide to live with, and this
 * is not one of them. The only way to clear it is to sign in, or to repair a
 * store ADE could not read.
 *
 * It registers with the app banner host in the account band, which sorts ahead
 * of every other docked banner, so it can never fold into the host's "N more"
 * overflow. It mounts in `AppShell` outside every project condition, because
 * this bar has to reach every surface — welcome and projectless chats too.
 *
 * The copy for all four session states lives in one record in
 * `lib/account.ts`, so this component never decides what a state says.
 *
 * The same bar also carries the one account problem a signed-in person can
 * have: the account directory refuses THIS computer (it was removed, or it
 * needs a fresh confirmation to rejoin). The automatic repair gives up on that
 * quietly, and a diagnostic toast was the only sign of it, so one install sat
 * disconnected for a month. It is not dismissable for the same reason: the fix
 * is one button away, and hiding it is how nobody noticed.
 */
export function AccountSignedOutBanner({ navigate }: { navigate: NavigateFunction }): null {
  useAppBanner(useAccountBannerModel(navigate), {
    placement: "docked",
    priority: APP_BANNER_PRIORITY.account,
  });
  return null;
}

function useAccountBannerModel(navigate: NavigateFunction): BannerModel | null {
  const { status, loading } = useAccountStatus();
  const location = useLocation();
  const state = accountSessionState(status);
  const copy = accountSessionBanner(state);
  const { refusal, refresh: refreshRefusal } = useThisComputerRefusal();
  const reconnect = useReconnectThisComputer({ onSettled: refreshRefusal });

  const goToAccount = useCallback(() => {
    navigate("/account", {
      state: { returnTo: `${location.pathname}${location.search}${location.hash}` },
    });
  }, [location.hash, location.pathname, location.search, navigate]);

  // Stay silent until the first status lands. A bar that claims "signed out"
  // for the half-second before the status arrives is wrong on every launch.
  if (loading) return null;

  // Already on the account page — the bar would point at the page you are on.
  // The page's own card carries the same Reconnect button. Inside a project
  // the account page is the Account section of Settings.
  if (location.pathname === "/account" || location.pathname.startsWith("/account/")) return null;
  if (location.pathname === "/settings" && new URLSearchParams(location.search).get("tab") === "account") return null;

  if (copy) {
    return {
      id: `account-${state}`,
      tone: "warning",
      icon: ACCOUNT_ICON,
      title: copy.title,
      detail: copy.detail,
      actions: [{ label: copy.action, onClick: goToAccount, variant: "primary" }],
      dismiss: false,
    };
  }

  if (state !== "active" || !refusal || !reconnect.available) return null;

  const refusalCopy = describeThisComputerRefusal(refusal);
  const action = reconnect.view({ label: refusalCopy.action, detail: refusalCopy.detail });

  return {
    id: "this-computer-refused",
    tone: "warning",
    icon: REFUSED_ICON,
    busy: reconnect.reconnecting,
    title: refusalCopy.title,
    detail: action.detail,
    actions: [{
      label: action.label,
      onClick: action.onClick,
      disabled: action.disabled,
      busy: Boolean(action.disabled && reconnect.reconnecting),
      variant: action.cancels ? "secondary" : "primary",
    }],
    dismiss: false,
  };
}
