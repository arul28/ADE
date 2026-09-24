import { memo, useEffect, useRef, type ReactNode } from "react";
import { cn } from "../../ui/cn";
import { Banner } from "../../ui/notice";
import { ToolLogo } from "../ToolLogos";
import { PROVIDER_TOOL_TYPE, type ExternalSessionSummary } from "./contract";
import { sessionKey, type SessionPlace } from "./importBrowserModel";
import { LiveBadge, MetaSeparator, PlaceLabel } from "./ImportSessionParts";
import { formatPromptCount, formatUpdatedAtCompact, sessionHeading } from "./sessionPresentation";

export type SessionGroup = { label: string; rows: ExternalSessionSummary[] };

const ImportSessionRow = memo(function ImportSessionRow({
  summary,
  place,
  showPlace,
  active,
  onSelect,
}: {
  summary: ExternalSessionSummary;
  place: SessionPlace;
  /** False when the lane filter already names the lane every row is in. */
  showPlace: boolean;
  active: boolean;
  onSelect: (key: string) => void;
}) {
  const key = sessionKey(summary);
  const when = formatUpdatedAtCompact(summary.updatedAt);
  const prompts = formatPromptCount(summary.messageCount);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-import-row={key}
      onClick={() => onSelect(key)}
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-75",
        active
          ? "bg-white/[0.07] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"
          : "hover:bg-white/[0.035] focus-visible:bg-white/[0.035]",
      )}
    >
      <ToolLogo
        toolType={PROVIDER_TOOL_TYPE[summary.provider]}
        size={16}
        className={cn("mt-[1px] shrink-0 transition-opacity", active ? "opacity-100" : "opacity-80")}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[12.5px] font-medium", active ? "text-fg" : "text-fg/85")}>
            {sessionHeading(summary)}
          </span>
          {summary.possiblyActive ? <LiveBadge compact /> : null}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-fg/60">
          {showPlace ? <PlaceLabel place={place} className="max-w-[150px]" /> : null}
          {when ? <>{showPlace ? <MetaSeparator /> : null}<span className="shrink-0">{when}</span></> : null}
          {prompts ? <><MetaSeparator /><span className="shrink-0 truncate">{prompts}</span></> : null}
          {summary.alreadyImported ? (
            <span className="ml-auto shrink-0 text-[10px] text-muted-fg/45">In ADE</span>
          ) : summary.importedBefore ? (
            <span className="ml-auto shrink-0 text-[10px] text-muted-fg/45">Copied before</span>
          ) : null}
        </span>
      </span>
    </button>
  );
});

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-1 px-2 pt-1" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-start gap-2.5 px-2.5 py-2">
          <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-white/[0.05]" />
          <div className="min-w-0 flex-1">
            <div className="h-3 animate-pulse rounded bg-white/[0.05]" style={{ width: `${78 - index * 9}%` }} />
            <div className="mt-1.5 h-2.5 w-2/5 animate-pulse rounded bg-white/[0.035]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ImportSessionList({
  groups,
  activeKey,
  placeOf,
  hidePlace = false,
  onSelect,
  loading,
  empty,
  notice,
}: {
  groups: SessionGroup[];
  activeKey: string | null;
  placeOf: (summary: ExternalSessionSummary) => SessionPlace;
  /** Hide each row's lane label: the filter already names that one lane. */
  hidePlace?: boolean;
  onSelect: (key: string) => void;
  loading: boolean;
  /** Shown when nothing matches the filters. */
  empty: ReactNode;
  /** One muted line for providers that failed to scan. */
  notice: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasRows = groups.length > 0;

  // Keyboard moves the selection; keep it in view without animating.
  useEffect(() => {
    if (!activeKey) return;
    const rows = scrollRef.current?.querySelectorAll<HTMLElement>("[data-import-row]") ?? [];
    const row = Array.from(rows).find((candidate) => candidate.dataset.importRow === activeKey);
    if (!row) return;
    if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    // Roving focus: when a row had focus, the new selection takes it.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== row && focused.dataset.importRow != null) {
      row.focus({ preventScroll: true });
    }
  }, [activeKey]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2"
      data-scroll-lock-scrollable=""
      onWheel={(event) => event.stopPropagation()}
    >
      {hasRows ? (
        <div role="listbox" aria-label="Sessions">
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <div
                aria-hidden="true"
                className="sticky top-0 z-[1] px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-fg/45"
                style={{ backgroundColor: "var(--color-modal-bg, var(--color-card, #1A1830))" }}
              >
                {group.label}
              </div>
              <div className="flex flex-col gap-px px-2">
                {group.rows.map((summary) => {
                  const key = sessionKey(summary);
                  return (
                    <ImportSessionRow
                      key={key}
                      summary={summary}
                      place={placeOf(summary)}
                      showPlace={!hidePlace}
                      active={key === activeKey}
                      onSelect={onSelect}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {loading ? (
        <>
          <span role="status" className="sr-only">Scanning for sessions…</span>
          <SkeletonRows count={hasRows ? 2 : 6} />
        </>
      ) : null}
      {!hasRows && !loading ? empty : null}
      {notice ? (
        <Banner
          layout="inline"
          style={{ margin: "10px 12px 0" }}
          model={{ id: "external-session-scan-warning", tone: "warning", title: notice }}
        />
      ) : null}
    </div>
  );
}
