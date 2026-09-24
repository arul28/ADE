import { useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router-dom";
import {
  ArrowCounterClockwise,
  CheckCircle,
  GitBranch,
  GithubLogo,
  GitPullRequest,
  LinkSimple,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";

import type { LaneSummary, PrEventPayload } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { LaneAccentDot } from "../../lanes/LaneAccentDot";
import { buildPrsRouteSearch, type PrDetailRouteTab } from "../../prs/prsRouteState";
import { LaneIcon } from "../../ui/vcsIcons";
import {
  getPrToastHeadline,
  getPrToastMeta,
  getPrToastSummary,
  getPrToastTone,
} from "../prToastPresentation";
import { dismissToast, showToast, updateToast, type ToastCardAction, type ToastChip, type ToastInput } from "./toastStore";

type PrNotificationEvent = Extract<PrEventPayload, { type: "pr-notification" }>;
type PrAutoLinkedEvent = Extract<PrEventPayload, { type: "pr-auto-linked" }>;

/** PR notices stay up long enough to read a failing-check summary. */
export const PR_TOAST_DURATION_MS = 18_000;

type LaneRef = Pick<LaneSummary, "id" | "name" | "color">;

function prNotificationIcon(kind: PrNotificationEvent["kind"]) {
  if (kind === "checks_failing") return <XCircle size={15} weight="fill" />;
  if (kind === "changes_requested") return <WarningCircle size={15} weight="fill" />;
  if (kind === "merge_ready") return <CheckCircle size={15} weight="fill" />;
  return <GitPullRequest size={15} weight="fill" />;
}

function laneChip(laneName: string, laneColor: string | null | undefined): ToastChip {
  return {
    label: laneName,
    color: laneColor ?? null,
    icon: laneColor ? <LaneAccentDot color={laneColor} size={7} /> : <LaneIcon size={10} />,
  };
}

/** Stable per PR and kind, so a repeated event refreshes its card instead of stacking a twin. */
export function prNotificationToastId(event: PrNotificationEvent): string {
  return `pr-notification:${event.prId}:${event.kind}`;
}

/** Pure: the store toast for one `pr-notification` event. */
export function buildPrNotificationToast(
  event: PrNotificationEvent,
  lane: LaneRef | null,
  navigate: NavigateFunction,
): ToastInput & { id: string } {
  const id = prNotificationToastId(event);
  const laneName = lane?.name ?? event.laneId;
  const repoLabel = [event.repoOwner, event.repoName].filter(Boolean).join("/");
  const chips: ToastChip[] = getPrToastMeta(event, laneName).map((item) => {
    if (laneName && item === laneName) return laneChip(item, lane?.color);
    if (repoLabel && item === repoLabel) return { label: item, icon: <GithubLogo size={10} /> };
    return { label: item, icon: <GitBranch size={10} /> };
  });

  const openInAde = () => {
    let detailTab: PrDetailRouteTab | null = null;
    if (event.kind === "checks_failing") {
      detailTab = "checks";
    } else if (event.kind === "changes_requested" || event.kind === "review_requested") {
      detailTab = "overview";
    }
    const search = buildPrsRouteSearch({
      activeTab: "normal",
      selectedPrId: event.prId,
      selectedPrNumber: event.prNumber,
      repoOwner: event.repoOwner,
      repoName: event.repoName,
      selectedRebaseItemId: null,
      detailTab,
    });
    navigate(`/prs${search}`);
  };

  const actions: ToastCardAction[] = [
    {
      label: "Open in ADE",
      variant: "secondary",
      icon: <GitPullRequest size={12} />,
      onClick: openInAde,
    },
    {
      label: "Open on GitHub",
      variant: "solid",
      icon: <GithubLogo size={12} weight="fill" />,
      // Stays up if GitHub could not be opened, so the user can try again.
      keepOpen: true,
      onClick: () => {
        void window.ade.prs.openInGitHub(event.prId).then(
          () => dismissToast(id),
          () => {
            /* keep toast visible on failure */
          },
        );
      },
    },
  ];

  return {
    id,
    tone: getPrToastTone(event.kind, event.checksStatus),
    icon: prNotificationIcon(event.kind),
    badge: event.title,
    eyebrow: `#${event.prNumber}`,
    title: getPrToastHeadline(event),
    chips,
    message: getPrToastSummary(event),
    actions,
    closeTitle: "Dismiss",
    durationMs: PR_TOAST_DURATION_MS,
  };
}

export function autoLinkedPrToastId(event: PrAutoLinkedEvent): string {
  return `pr-auto-linked:${event.prId || event.prNumber}`;
}

function autoLinkUndoAction(
  id: string,
  event: PrAutoLinkedEvent,
  state: { undoing: boolean; failed: boolean },
): ToastCardAction {
  return {
    label: state.failed ? "Retry undo" : "Undo",
    variant: "secondary",
    icon: <ArrowCounterClockwise size={12} />,
    busy: state.undoing,
    keepOpen: true,
    onClick: () => {
      if (!event.prId) {
        dismissToast(id);
        return;
      }
      updateToast(id, {
        error: undefined,
        actions: [autoLinkUndoAction(id, event, { undoing: true, failed: false })],
      });
      void window.ade.prs
        .delete({ prId: event.prId, closeOnGitHub: false, archiveLane: false })
        .then(
          () => dismissToast(id),
          (error) => {
            console.error(`Failed to undo auto-link for PR #${event.prNumber} (${event.prId})`, error);
            updateToast(id, {
              error: "Couldn't undo the link. Try again.",
              actions: [autoLinkUndoAction(id, event, { undoing: false, failed: true })],
            });
          },
        );
    },
  };
}

/** Pure: the store toast for one `pr-auto-linked` event. */
export function buildAutoLinkedPrToast(
  event: PrAutoLinkedEvent,
  lane: LaneRef | null,
): ToastInput & { id: string } {
  const id = autoLinkedPrToastId(event);
  const laneName = lane?.name ?? event.laneName;
  return {
    id,
    tone: "accent",
    icon: <LinkSimple size={15} weight="bold" />,
    title: `Auto-linked PR #${event.prNumber}`,
    chips: laneName ? [laneChip(laneName, lane?.color)] : undefined,
    message: event.prTitle,
    actions: [autoLinkUndoAction(id, event, { undoing: false, failed: false })],
    closeTitle: "Dismiss",
    durationMs: PR_TOAST_DURATION_MS,
  };
}

function findLane(laneId: string): LaneRef | null {
  return useAppStore.getState().lanes.find((lane) => lane.id === laneId) ?? null;
}

/**
 * PR events → the shared toast stack: status notifications (failing checks,
 * review requests, merge-ready…), auto-linked PRs with Undo, and the "sessions
 * settled" note after a merge.
 */
export function usePrEventToasts(navigate: NavigateFunction): void {
  // Read through a ref: the subscription is window-lifetime and must not churn
  // when the router hands out a new `navigate`.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const go: NavigateFunction = ((...args: Parameters<NavigateFunction>) =>
      (navigateRef.current as (...a: Parameters<NavigateFunction>) => unknown)(...args)) as NavigateFunction;
    const unsub = window.ade.prs.onEvent((event) => {
      if (event.type === "pr-sessions-auto-settled") {
        showToast({
          title: `PR #${event.prNumber} merged · ${event.settledCount} ${
            event.settledCount === 1 ? "session" : "sessions"
          } settled`,
          tone: "success",
        });
        return;
      }
      if (event.type === "pr-auto-linked") {
        showToast(buildAutoLinkedPrToast(event, findLane(event.laneId)));
        return;
      }
      if (event.type !== "pr-notification") return;
      showToast(buildPrNotificationToast(event, findLane(event.laneId), go));
    });
    return () => {
      unsub();
    };
  }, []);
}
