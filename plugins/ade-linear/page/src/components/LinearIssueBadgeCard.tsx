/**
 * The compiled Linear badge's HOVER CARD, moved.
 *
 * Source: `apps/desktop/src/renderer/components/lanes/LinearIssueBadge.tsx` —
 * the card half only. The chip itself stays ADE's own chrome: the lanes row
 * draws it and the host pops THIS over it, so the compiled component's outer
 * `<span className="group relative inline-flex shrink-0">` chip and its
 * `pointer-events-none invisible … group-hover:visible` positioning wrapper are
 * both the host's job now and are not here. Everything the wrapper contained is
 * verbatim: the Linear header strip, the priority/state icons, the identifier,
 * the title, the Project/Status/Priority/Assignee grid, the branch, the labels
 * and the footer verbs.
 *
 * `w-[280px]` moved from the compiled positioning wrapper onto the card root,
 * because that wrapper was where the compiled card's width lived and the host's
 * popover frame sizes to what the page measures.
 *
 * The `useBuiltinSurfaceVisible("linear")` gate the compiled badge opened with
 * is gone: it existed so ADE's own badge would stand down when `ade-linear` was
 * installed, and this page IS `ade-linear`.
 */

import React from "react";
import { ArrowSquareOut, ChatCircleText, Check, Clipboard, WarningCircle } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LinearMark, LinearPriorityIcon, LinearStateIcon, LINEAR_BRAND } from "@ade-dev/ui";

import type { LaneLinearIssue } from "../types";
import { openLink, writeClipboard } from "../host/ui";

function priorityLabel(issue: LaneLinearIssue): string {
  if (issue.priorityLabel === "none" || !issue.priorityLabel) return "No priority";
  return issue.priorityLabel[0]!.toUpperCase() + issue.priorityLabel.slice(1);
}

function isSafeExternalUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

type CopyState = "idle" | "copied" | "error";

function copyButtonColor(state: CopyState): string {
  switch (state) {
    case "error": return "#FCA5A5";
    case "copied": return "#86EFAC";
    default: return "rgba(199,205,245,0.85)";
  }
}

function copyButtonIcon(state: CopyState): React.ReactNode {
  switch (state) {
    case "copied": return <Check size={11} weight="bold" />;
    case "error": return <WarningCircle size={11} weight="bold" />;
    default: return <Clipboard size={11} />;
  }
}

function copyButtonLabel(state: CopyState): string {
  switch (state) {
    case "copied": return "Copied";
    case "error": return "Copy failed";
    default: return "Copy link";
  }
}

export function LinearIssueBadgeCard({
  issue,
  onStartChatWithIssue,
}: {
  issue: LaneLinearIssue;
  onStartChatWithIssue?: () => void;
}) {
  const [copyState, setCopyState] = React.useState<CopyState>("idle");
  const project = issue.projectName?.trim() || issue.projectSlug || issue.teamKey;

  React.useEffect(() => {
    if (copyState === "idle") return undefined;
    const timer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const handleCopyIssueLink = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!issue.url) return;
    try {
      // The compiled ladder, with its first rung swapped: ADE's own
      // `window.ade.app.writeClipboardText` is the bridge's clipboard verb from
      // inside a guest. It answers false rather than throwing on a host too old
      // to have one, so the `navigator.clipboard` fallback and the final throw —
      // which is what paints the "Copy failed" state — both still stand.
      if (await writeClipboard(issue.url)) {
        // Copied by the host.
      } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(issue.url);
      } else {
        throw new Error("Clipboard access is not available.");
      }
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }, [issue.url]);

  const handleStartChatWithIssue = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onStartChatWithIssue?.();
  }, [onStartChatWithIssue]);

  return (
    <div className="w-[280px]">
      <span
        className="block overflow-hidden rounded-xl border shadow-xl"
        style={{
          borderColor: LINEAR_BRAND.borderSubtle,
          background: COLORS.cardBg,
          color: COLORS.textSecondary,
          backdropFilter: "blur(20px)",
        }}
      >
      {/* Linear-branded header strip */}
      <span
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{
          borderColor: "rgba(255,255,255,0.05)",
          background: LINEAR_BRAND.surface,
        }}
      >
        <span
          className="flex h-5 w-5 items-center justify-center rounded"
          style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
        >
          <LinearMark size={11} />
        </span>
        <span
          className="text-[11px] font-semibold tracking-tight"
          style={{ color: LINEAR_BRAND.text }}
        >
          Linear
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-fg/55">{issue.teamKey}</span>
      </span>

      <span className="block px-3 py-2.5">
        <span className="flex items-center gap-1.5">
          <LinearPriorityIcon priority={issue.priority} size={11} />
          <LinearStateIcon stateType={issue.stateType} size={11} />
          <span
            className="rounded font-mono text-[10px] font-semibold"
            style={{
              color: LINEAR_BRAND.text,
              background: LINEAR_BRAND.surface,
              padding: "1.5px 5px",
            }}
          >
            {issue.identifier}
          </span>
        </span>
        <span className="mt-1.5 block text-[12.5px] font-semibold leading-snug text-fg">{issue.title}</span>

        <span className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10.5px]">
          <span className="text-muted-fg/45">Project</span>
          <span className="truncate text-fg/85">{project}</span>
          <span className="text-muted-fg/45">Status</span>
          <span className="truncate text-fg/85">{issue.stateName}</span>
          <span className="text-muted-fg/45">Priority</span>
          <span className="truncate text-fg/85">{priorityLabel(issue)}</span>
          <span className="text-muted-fg/45">Assignee</span>
          <span className="truncate text-fg/85">{issue.assigneeName ?? "Unassigned"}</span>
        </span>

        {issue.branchName ? (
          <span className="mt-2.5 block">
            <span className="text-[10px] uppercase tracking-[0.10em] text-muted-fg/45">Branch</span>
            <span
              className="mt-1 block truncate rounded font-mono text-[10px] text-fg/85"
              style={{ background: "rgba(0,0,0,0.30)", padding: "4px 6px" }}
            >
              {issue.branchName}
            </span>
          </span>
        ) : null}

        {issue.labels.length > 0 ? (
          <span className="mt-2.5 flex flex-wrap gap-1">
            {issue.labels.slice(0, 4).map((label) => (
              <span
                key={label}
                className="rounded-full px-2 py-0.5 text-[9.5px] text-muted-fg/80"
                style={{ background: "rgba(255,255,255,0.04)" }}
              >
                {label}
              </span>
            ))}
          </span>
        ) : null}
      </span>

      {(onStartChatWithIssue || issue.url) ? (
        <span
          className="flex items-center gap-1.5 border-t px-3 py-2"
          style={{ borderColor: "rgba(255,255,255,0.05)", background: "rgba(0,0,0,0.20)" }}
        >
          {onStartChatWithIssue ? (
            <button
              type="button"
              className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded text-[10.5px] font-medium transition-colors"
              style={{
                color: LINEAR_BRAND.text,
                background: LINEAR_BRAND.surface,
                border: `1px solid ${LINEAR_BRAND.borderSubtle}`,
              }}
              title="Start a new chat with this Linear issue attached"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={handleStartChatWithIssue}
            >
              <ChatCircleText size={11} weight="fill" />
              Start chat with context
            </button>
          ) : null}
          {issue.url ? (
            <>
              <button
                type="button"
                className="inline-flex h-6 items-center gap-1 rounded px-2 text-[10.5px] font-medium transition-colors hover:bg-white/[0.06]"
                style={{
                  color: copyButtonColor(copyState),
                  background: copyState === "copied" ? "rgba(34,197,94,0.10)" : "transparent",
                }}
                title="Copy Linear issue link"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={handleCopyIssueLink}
              >
                {copyButtonIcon(copyState)}
                {copyButtonLabel(copyState)}
              </button>
              <button
                type="button"
                className="inline-flex h-6 items-center justify-center rounded px-1.5 text-muted-fg/65 transition-colors hover:bg-white/[0.06] hover:text-fg"
                title="Open in Linear"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  // `window.ade.app.openExternal` → `openLink`. The compiled
                  // guard stays: the host takes `http(s)` and `ade://`, and this
                  // verb means "the reader's real browser", so a URL that is
                  // neither is still refused here rather than handed over.
                  if (isSafeExternalUrl(issue.url)) void openLink(issue.url);
                }}
              >
                <ArrowSquareOut size={11} weight="bold" />
              </button>
            </>
          ) : null}
        </span>
      ) : null}
      </span>
    </div>
  );
}
