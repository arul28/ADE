import React, { useEffect, useRef } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretLeft,
  Check,
  CheckCircle,
  Lightning,
  WarningCircle,
  WifiSlash,
  X,
  XCircle,
} from "@phosphor-icons/react";

import type { AttentionAction, AttentionItem } from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { ProviderLogo } from "../shared/ProviderLogos";
import { SessionStatusLabel } from "../terminals/SessionStatusLabel";
import { cn } from "../ui/cn";
import { activityCardPreview } from "./ActivityCard";
import { activityItemPresentation, activityActionTone } from "./activityPresentation";

function actionIcon(action: AttentionAction): React.ElementType {
  if (action.kind === "approve") return Check;
  if (action.kind === "deny") return X;
  if (action.kind === "restart" || action.kind === "rerun_checks") return ArrowClockwise;
  if (action.kind === "open") return ArrowSquareOut;
  if (action.kind === "dismiss") return XCircle;
  if (action.kind === "mark_seen") return CheckCircle;
  return Lightning;
}

/** Seen and dismiss are local bookkeeping; everything else needs the machine. */
function actionWorksOffline(action: AttentionAction): boolean {
  return action.kind === "mark_seen" || action.kind === "dismiss";
}

/**
 * The slide-over detail. It covers the columns rather than replacing one, so
 * the row you came from is still where you left it when you close the sheet.
 *
 * There is no placeholder twin of this component. The old center rendered a
 * "Ready when you are" card whenever nothing was selected and again whenever a
 * selected item happened to carry no detail — an apology for a state that only
 * ever meant "you have not clicked anything yet". Nothing selected now renders
 * nothing at all.
 */
export function ActivityDetailSheet({
  item,
  hideDetails,
  pendingActionId,
  errorMessage,
  onClose,
  onOpen,
  onAction,
}: {
  item: AttentionItem;
  hideDetails: boolean;
  pendingActionId: string | null;
  errorMessage: string | null;
  onClose: () => void;
  onOpen: (item: AttentionItem) => void;
  onAction: (item: AttentionItem, action: AttentionAction) => void;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const presentation = activityItemPresentation(item);
  const tone = presentation?.tone ?? "neutral";
  const note = activityCardPreview(item, hideDetails);
  const planTotal = Math.max(0, item.planProgress?.total ?? 0);
  const planCompleted = Math.min(planTotal, Math.max(0, item.planProgress?.completed ?? 0));
  const planPercent = planTotal > 0 ? Math.round((planCompleted / planTotal) * 100) : 0;
  const actions = item.actions.filter(
    (action) => action.kind !== "open" && action.kind !== "mark_seen",
  );

  // Focus lands in the sheet so Escape, Tab and a screen reader all agree that
  // this is the thing on top now.
  useEffect(() => {
    sheetRef.current?.focus();
  }, [item.id]);

  return (
    <>
      <button
        type="button"
        className="activity-sheet-scrim"
        aria-label="Close detail"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className={cn("activity-sheet", `activity-tone-${tone}`)}
        role="dialog"
        aria-label={`${item.title} detail`}
        tabIndex={-1}
        data-activity-detail={item.id}
      >
        <header className="activity-sheet-head">
          <button
            type="button"
            className="activity-pane-icon-button"
            aria-label="Back to Activity"
            title="Back"
            onClick={onClose}
          >
            <CaretLeft size={14} weight="bold" />
          </button>
          <span className="activity-sheet-breadcrumb">
            <span className="truncate">{item.machine.name}</span>
            <span aria-hidden>/</span>
            <span className="truncate">{item.project.name}</span>
            {item.laneName ? (
              <>
                <span aria-hidden>/</span>
                <span className="truncate">{item.laneName}</span>
              </>
            ) : null}
          </span>
          <SessionStatusLabel
            presentation={presentation}
            elapsedSince={item.statusSince ?? item.occurredAt}
            timestampLabel={relativeWhen(item.updatedAt)}
            compact={false}
          />
          <button
            type="button"
            className="activity-pane-icon-button"
            onClick={() => onOpen(item)}
            title={`Open ${item.title}`}
          >
            <ArrowSquareOut size={13} />
          </button>
        </header>

        <div className="activity-sheet-body">
          <div>
            <div className="activity-sheet-kicker">
              <ProviderLogo
                family={item.kind === "pull_request" ? "github" : item.provider || "agent"}
                size={14}
              />
              <span>{presentation?.label ?? "Tracked"}</span>
              <span aria-hidden className="text-muted-fg/40">·</span>
              <span className="font-normal text-muted-fg">
                {relativeWhen(item.updatedAt)}
              </span>
            </div>
            <h3 className="activity-sheet-title">{item.title}</h3>
            {note ? <p className="activity-sheet-note">{note}</p> : null}
          </div>

          <div className="activity-sheet-meta">
            {item.model ? <span>{item.model}</span> : null}
            <span>
              {item.machine.name}
              {item.machine.online
                ? " · online"
                : item.machine.lastSeenAt
                  ? ` · last seen ${relativeWhen(item.machine.lastSeenAt)}`
                  : " · offline"}
            </span>
            <span>{item.project.name}</span>
            {item.laneName ? <span>{item.laneName}</span> : null}
          </div>

          {item.machine.online ? null : (
            <div className="activity-sheet-banner" role="status">
              <WifiSlash size={14} />
              <span>
                <strong>{item.machine.name} is offline.</strong>{" "}
                This is its last-known state. Remote actions unlock when it reconnects.
              </span>
            </div>
          )}

          {errorMessage ? (
            <div className="activity-sheet-banner" data-tone="error" role="alert">
              <WarningCircle size={14} weight="fill" />
              <span>{errorMessage}</span>
            </div>
          ) : null}

          {actions.length > 0 ? (
            <div className="activity-sheet-section">
              <h4>Actions</h4>
              <div className="activity-sheet-actions">
                {actions.map((action) => {
                  const blocked = !item.machine.online && !actionWorksOffline(action);
                  const Icon = actionIcon(action);
                  return (
                    <button
                      key={action.id}
                      type="button"
                      className="activity-action"
                      data-tone={activityActionTone(action.kind)}
                      disabled={blocked || pendingActionId === action.id}
                      title={blocked ? `${item.machine.name} is offline` : action.label}
                      onClick={() => onAction(item, action)}
                    >
                      <Icon size={13} weight={action.kind === "approve" ? "bold" : "regular"} />
                      {pendingActionId === action.id ? "Working…" : action.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {item.planProgress ? (
            <div className="activity-sheet-section">
              <h4>Plan progress</h4>
              <div
                className="activity-progress-track"
                role="progressbar"
                aria-label="Plan progress"
                aria-valuemin={0}
                aria-valuemax={planTotal}
                aria-valuenow={planCompleted}
              >
                <div className="activity-progress-fill" style={{ width: `${planPercent}%` }} />
              </div>
              <p className="activity-plan-current">
                {planCompleted} of {planTotal}
                {item.planProgress.current ? ` · ${item.planProgress.current}` : ""}
              </p>
            </div>
          ) : null}

          {item.recentActivity?.length ? (
            <div className="activity-sheet-section">
              <h4>Recent activity</h4>
              <ol className="activity-recent">
                {item.recentActivity.slice(0, 8).map((entry, index) => (
                  <li key={`${entry}:${index}`}>
                    <span className="activity-recent-node" aria-hidden />
                    <span>{entry}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          <div className="activity-sheet-actions">
            <button
              type="button"
              className="activity-action"
              data-tone="primary"
              onClick={() => onOpen(item)}
            >
              <ArrowSquareOut size={13} />
              Open
            </button>
            <button
              type="button"
              className="activity-action"
              data-tone="ghost"
              disabled={pendingActionId === `dismiss:${item.id}`}
              onClick={() => onAction(item, {
                id: `dismiss:${item.id}`,
                kind: "dismiss",
                label: "Dismiss",
              })}
            >
              <XCircle size={13} />
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
