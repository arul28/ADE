import { settingsRouteFor } from "../../../shared/settingsManifest";
// The store, not the notice index: the host that draws the banner is already in
// the app chunk, and this module only registers one.
import { APP_BANNER_PRIORITY, useAppBanner } from "../../components/ui/notice/appBannerStore";
import type { BannerModel } from "../../components/ui/notice/Banner";
import type { NoticeAction } from "../../components/ui/notice/NoticeParts";
import { useOptionalWebWorkspace } from "../workspace/WebWorkspaceContext";
import { navigateMountedApp } from "./ownedLinkResolution";

/**
 * The app banner for a link that opens on the machine and project that own it:
 * a busy line while ADE connects and opens, then what went wrong and how to go
 * on. Loaded with the app chunk, so the boot entry carries no notice code.
 */
export function WebOwnedLinkBanner(): null {
  const workspace = useOptionalWebWorkspace();
  const state = workspace?.ownedLink ?? null;
  let model: BannerModel | null = null;
  if (state?.status === "resolving") {
    model = {
      id: "web-owned-link",
      tone: "info",
      busy: true,
      title: state.message,
    };
  } else if (state?.status === "failed") {
    const { failure } = state;
    const actions: NoticeAction[] = [];
    if (failure.retryable && workspace?.retryOwnedLink) {
      actions.push({ label: "Try again", onClick: () => workspace.retryOwnedLink?.() });
    }
    if (failure.offerComputers) {
      actions.push({
        label: "Your computers",
        variant: "secondary",
        onClick: () => {
          workspace?.dismissOwnedLink?.();
          navigateMountedApp(settingsRouteFor("account.computers"));
        },
      });
    }
    model = {
      id: "web-owned-link",
      tone: failure.kind === "entity-missing" ? "warning" : "error",
      title: failure.title,
      ...(failure.detail ? { detail: failure.detail } : {}),
      actions,
      // Each of these is the person's to fix on their own computer, not a
      // fault in ADE to report.
      report: false,
      dismiss: { onDismiss: () => workspace?.dismissOwnedLink?.() },
    };
  }
  useAppBanner(model, { priority: APP_BANNER_PRIORITY.project });
  return null;
}
