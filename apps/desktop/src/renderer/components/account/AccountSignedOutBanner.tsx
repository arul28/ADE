import { useCallback } from "react";
import { useLocation, type NavigateFunction } from "react-router-dom";
import { accountSessionBanner, accountSessionState, useAccountStatus } from "../../lib/account";
import { describeThisComputerRefusal } from "../../lib/thisComputerRefusal";
import { useReconnectThisComputer } from "../../hooks/useReconnectThisComputer";
import { useThisComputerRefusal } from "../../hooks/useThisComputerRefusal";
import { Banner, type BannerModel } from "../shared/Banner";

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
 * It mounts above `IntegrationBannerHost` rather than inside it, because that
 * host renders only inside an open project (`AppShell`), and this bar has to
 * reach every surface — welcome, projectless chats, and the account page
 * itself.
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
export function AccountSignedOutBanner({ navigate }: { navigate: NavigateFunction }): JSX.Element | null {
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
  // The page's own card carries the same Reconnect button.
  if (location.pathname === "/account" || location.pathname.startsWith("/account/")) return null;

  if (copy) {
    const model: BannerModel = {
      id: `account-${state}`,
      severity: "warning",
      title: copy.title,
      detail: copy.detail,
      actions: [{ label: copy.action, onClick: goToAccount, variant: "primary" }],
      dismiss: false,
    };
    return (
      <div className="shrink-0 mx-2 mt-1" data-testid="account-signed-out-banner" data-session-state={state}>
        <Banner model={model} />
      </div>
    );
  }

  if (state !== "active" || !refusal || !reconnect.available) return null;

  const refusalCopy = describeThisComputerRefusal(refusal);
  const action = reconnect.view({ label: refusalCopy.action, detail: refusalCopy.detail });

  const model: BannerModel = {
    id: "this-computer-refused",
    severity: "warning",
    title: refusalCopy.title,
    detail: action.detail,
    actions: [{
      label: action.label,
      onClick: action.onClick,
      disabled: action.disabled,
      variant: action.cancels ? "secondary" : "primary",
    }],
    dismiss: false,
  };
  return (
    <div className="shrink-0 mx-2 mt-1" data-testid="this-computer-refused-banner" data-refusal-code={refusal.code}>
      <Banner model={model} />
    </div>
  );
}
