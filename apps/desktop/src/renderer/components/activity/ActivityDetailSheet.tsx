import React, { useEffect, useRef } from "react";
import {
  ArrowSquareOut,
  CaretLeft,
  WarningCircle,
  WifiSlash,
  XCircle,
} from "@phosphor-icons/react";

import type { AttentionAction, AttentionItem } from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { ProviderLogo } from "../shared/ProviderLogos";
import { cn } from "../ui/cn";
import { activityCardPreview } from "./ActivityCard";
import { ActivityStateGlyphMark } from "./ActivityStateGlyphMark";
import {
  activityItemPresentation,
  activityStateElapsed,
  activityStateGroup,
  activityStateSentence,
} from "./activityPresentation";

/**
 * The slide-over detail. It covers the columns rather than replacing one, so
 * the row you came from is still where you left it when you close the sheet.
 *
 * ── What this is, and what it deliberately is not ──────────────────────────
 *
 * v1 answers exactly two questions: WHAT IS THIS AGENT DOING, and HOW DO I GET
 * TO IT. The state sentence and one primary button. Everything else on screen
 * is context the item already carried — its own words, its plan, what it just
 * did, where it lives — laid out to be read rather than filled in.
 *
 * It used to render the item's `actions[]` as live approve/deny buttons. Those
 * are gone on purpose: an Activity row very often belongs to another machine,
 * and an approve button that can only sometimes approve is worse than no button
 * — it teaches the user that the sheet lies. Approving happens in the chat,
 * which is one click away. Live enrichment (transcript tail, PR checks) is the
 * same call: it needs a reachable machine, so it waits for a pass that can
 * promise one.
 *
 * There is no placeholder twin of this component either. The old center
 * rendered a "Ready when you are" card whenever nothing was selected. Nothing
 * selected now renders nothing at all.
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
  const group = activityStateGroup(item);
  const note = activityCardPreview(item, hideDetails);
  const elapsed = activityStateElapsed(item);
  const planTotal = Math.max(0, item.planProgress?.total ?? 0);
  const planCompleted = Math.min(planTotal, Math.max(0, item.planProgress?.completed ?? 0));
  const planPercent = planTotal > 0 ? Math.round((planCompleted / planTotal) * 100) : 0;
  const dismissActionId = `dismiss:${item.id}`;

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
          <span className="activity-sheet-when">{relativeWhen(item.updatedAt)}</span>
        </header>

        <div className="activity-sheet-body">
          {/* The state, said once, in words — the sheet's whole reason to
              exist. The glyph and hue repeat it for the eye; the elapsed
              reading comes off `statusSince`, so it is time in THIS state
              rather than time since the last cosmetic republish. */}
          <div className="activity-sheet-state" data-activity-state={group}>
            <span className="activity-sheet-state-mark" aria-hidden>
              <ActivityStateGlyphMark group={group} size={13} />
            </span>
            <span className="activity-sheet-state-copy">
              <strong>{activityStateSentence(item)}</strong>
              {elapsed ? (
                <span>
                  {presentation?.label ?? "Tracked"} for {elapsed}
                </span>
              ) : null}
            </span>
            <ProviderLogo
              family={item.kind === "pull_request" ? "github" : item.provider || "agent"}
              size={16}
              className="shrink-0 opacity-70"
            />
          </div>

          <div>
            <h3 className="activity-sheet-title">{item.title}</h3>
            {note ? <p className="activity-sheet-note">{note}</p> : null}
          </div>

          <div className="activity-sheet-actions">
            <button
              type="button"
              className="activity-action"
              data-tone="primary"
              onClick={() => onOpen(item)}
            >
              <ArrowSquareOut size={13} />
              {item.kind === "pull_request" ? "Open pull request" : "Open chat"}
            </button>
            <button
              type="button"
              className="activity-action"
              data-tone="ghost"
              disabled={pendingActionId === dismissActionId}
              onClick={() => onAction(item, {
                id: dismissActionId,
                kind: "dismiss",
                label: "Dismiss",
              })}
            >
              <XCircle size={13} />
              Dismiss
            </button>
          </div>

          {item.machine.online ? null : (
            <div className="activity-sheet-banner" role="status">
              <WifiSlash size={14} />
              <span>
                <strong>{item.machine.name} is offline.</strong>{" "}
                This is its last-known state. Opening it will reconnect first.
              </span>
            </div>
          )}

          {errorMessage ? (
            <div className="activity-sheet-banner" data-tone="error" role="alert">
              <WarningCircle size={14} weight="fill" />
              <span>{errorMessage}</span>
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

          {/* The quiet facts last, as one line of chips rather than a form:
              nobody opened this sheet to read a model id, but they will want it
              when the answer is "wrong model". */}
          <div className="activity-sheet-meta">
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
            {item.model ? <span>{item.model}</span> : null}
          </div>
        </div>
      </div>
    </>
  );
}
