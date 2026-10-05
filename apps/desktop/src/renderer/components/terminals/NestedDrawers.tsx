import React from "react";
import { CaretDown, CaretRight, Circle, CircleNotch, Terminal, UsersThree, X } from "@phosphor-icons/react";
import {
  NESTED_DRAWER_STATUS_PRESENTATION,
  attachedShellSectionId,
  nestedDrawerStatus,
  nestedSubagentSectionId,
  type NestedDrawerStatus,
} from "../../../shared/sessionSpawnNesting";
import { SESSION_TONE_TEXT_CLASS } from "../../../shared/sessionStatusPresentation";
import { pluralCount } from "../../../shared/formatting";
import type { TerminalSessionSummary } from "../../../shared/types/sessions";
import { cn } from "../ui/cn";
import { QUIET_LABEL_CLASS } from "./sessionListStyles";

/**
 * A chat's shell and subagent drawers in the Work list.
 *
 * They default to COLLAPSED: a busy agent can hang a dozen App Control shells
 * and subagents off one chat, and listing every one pushed the other chats off
 * the screen. A collapsed drawer keeps the full header strip — kind icon, kind
 * label and count, and the one state worth seeing (`nestedDrawerStatus`) — and
 * simply hides its rows. An opened drawer lists its rows below that same strip.
 */

export type NestedDrawerKind = "shells" | "subagents";

/**
 * The open state is recorded the same three-state way as the quiet shelves:
 * an explicit open writes `drawer-open:<sectionId>`, and absence is collapsed.
 * A legacy `chat:<id>` entry from the expanded-by-default days is inert.
 */
export function nestedDrawerOpenMarker(sectionId: string): string {
  return `drawer-open:${sectionId}`;
}

export function nestedDrawerSectionId(parentId: string, kind: NestedDrawerKind): string {
  return kind === "shells" ? attachedShellSectionId(parentId) : nestedSubagentSectionId(parentId);
}

function kindLabel(kind: NestedDrawerKind, count: number): string {
  return pluralCount(count, kind === "shells" ? "shell" : "subagent");
}

function KindIcon({ kind }: { kind: NestedDrawerKind }) {
  const Icon = kind === "shells" ? Terminal : UsersThree;
  return <Icon size={9} weight="regular" className="shrink-0 text-muted-fg/40" />;
}

const STATUS_GLYPH: Record<NonNullable<NestedDrawerStatus>, React.ReactNode> = {
  failed: <X size={8} weight="bold" aria-hidden />,
  needs_you: <Circle size={7} weight="fill" aria-hidden />,
  running: <CircleNotch size={8} weight="bold" aria-hidden />,
};

function StatusMark({ status }: { status: NestedDrawerStatus }) {
  if (!status) return null;
  const { label, tone } = NESTED_DRAWER_STATUS_PRESENTATION[status];
  return (
    <span className={cn("inline-flex shrink-0", SESSION_TONE_TEXT_CLASS[tone])} title={label}>
      {STATUS_GLYPH[status]}
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function NestedDrawers({
  parentId,
  shells,
  subagents,
  isCollapsed,
  onToggle,
  nowMs,
  renderChild,
}: {
  parentId: string;
  shells: TerminalSessionSummary[];
  subagents: TerminalSessionSummary[];
  isCollapsed: (sectionId: string) => boolean;
  /** Receives the open marker to toggle in the persisted section list. */
  onToggle: (openMarker: string) => void;
  nowMs: number;
  renderChild: (child: TerminalSessionSummary, kind: NestedDrawerKind) => React.ReactNode;
}) {
  const drawers = ([["subagents", subagents], ["shells", shells]] as const)
    .filter(([, children]) => children.length > 0)
    .map(([kind, children]) => {
      const sectionId = nestedDrawerSectionId(parentId, kind);
      return { kind, children, sectionId, collapsed: isCollapsed(sectionId) };
    });
  return (
    <>
      {drawers.map(({ kind, children, sectionId, collapsed }) => {
        const label = kindLabel(kind, children.length);
        const status = nestedDrawerStatus(children, nowMs);
        const statusLabel = status ? NESTED_DRAWER_STATUS_PRESENTATION[status].label : "";
        return (
          // `data-indented` for the card's bleed rule, same as a lane group body:
          // these rows hang off their own rail, so a left bleed would cross it.
          <div
            key={kind}
            className={cn("ml-3 border-l border-fg/[0.06] pl-1.5", collapsed ? "mt-0.5" : "mt-1")}
            data-indented="true"
            data-testid={kind === "subagents" ? "nested-subagent-section" : "nested-shell-section"}
          >
            <button
              type="button"
              onClick={() => onToggle(nestedDrawerOpenMarker(sectionId))}
              className={cn(
                "flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[9px] transition-colors hover:bg-fg/[0.03] hover:text-muted-fg/70",
                QUIET_LABEL_CLASS,
              )}
              aria-expanded={!collapsed}
              aria-label={`${collapsed ? `Show ${label}` : `Hide ${label}`}${statusLabel ? `, ${statusLabel}` : ""}`}
              title={collapsed ? `Show ${label}` : `Hide ${label}`}
            >
              {collapsed ? (
                <CaretRight size={9} weight="bold" className="shrink-0 text-muted-fg/40" />
              ) : (
                <CaretDown size={9} weight="bold" className="shrink-0 text-muted-fg/40" />
              )}
              <KindIcon kind={kind} />
              <span className="truncate">{label}</span>
              <StatusMark status={status} />
            </button>
            {collapsed ? null : (
              <div className="mt-1 flex flex-col gap-1">
                {children.map((child) => (
                  <div key={child.id}>{renderChild(child, kind)}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
